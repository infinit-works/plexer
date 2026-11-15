package wal

// Mutation models an uncompacted key update or tombstone deletion entry.
type Mutation struct {
	Key       string
	Value     []byte
	Tombstone bool
}

// CompactSegments merges log mutations and reclaims obsolete tombstone entries.
func CompactSegments(entries []Mutation) map[string][]byte {
	live := make(map[string][]byte)
	for _, entry := range entries {
		if entry.Tombstone {
			delete(live, entry.Key)
			continue
		}
		live[entry.Key] = entry.Value
	}
	return live
}
