package raft

import "math/rand"

// ElectionTracker coordinates randomized election timeouts and vote quorums.
type ElectionTracker struct {
	nodeID      string
	clusterSize int
	term        uint64
	timeoutMs   int
	votes       map[string]bool
}

func NewElectionTracker(nodeID string, clusterSize int) *ElectionTracker {
	return &ElectionTracker{
		nodeID:      nodeID,
		clusterSize: clusterSize,
		votes:       make(map[string]bool),
	}
}

func (e *ElectionTracker) ResetTimer(minMs int, maxMs int, rng *rand.Rand) int {
	span := maxMs - minMs
	if span <= 0 {
		e.timeoutMs = minMs
		return e.timeoutMs
	}
	e.timeoutMs = minMs + rng.Intn(span)
	return e.timeoutMs
}

func (e *ElectionTracker) StartElection() uint64 {
	e.term++
	e.votes = map[string]bool{e.nodeID: true}
	return e.term
}

func (e *ElectionTracker) RecordVote(peerID string, granted bool) bool {
	if granted {
		e.votes[peerID] = true
	}
	return len(e.votes) >= (e.clusterSize/2)+1
}
