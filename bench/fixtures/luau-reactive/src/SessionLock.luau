--!strict
-- Distributed datastore session lease lock with conflict retry and heartbeat renewal.

local SessionLock = {}

export type LeaseRecord = {
	ownerId: string,
	expiresAt: number,
	epoch: number,
}

function SessionLock.acquireLease(existing: LeaseRecord?, serverId: string, nowSec: number, ttlSec: number): (boolean, LeaseRecord)
	if existing and existing.ownerId ~= serverId and existing.expiresAt > nowSec then
		return false, existing
	end
	local nextEpoch = if existing then existing.epoch + 1 else 1
	return true, {
		ownerId = serverId,
		expiresAt = nowSec + ttlSec,
		epoch = nextEpoch,
	}
end

function SessionLock.renewLease(record: LeaseRecord, serverId: string, nowSec: number, ttlSec: number): LeaseRecord?
	if record.ownerId ~= serverId or record.expiresAt <= nowSec then
		return nil
	end
	record.expiresAt = nowSec + ttlSec
	return record
end

return SessionLock
