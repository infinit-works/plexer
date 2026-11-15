package main

import (
	"math/rand"

	"example.com/go-engine/internal/index"
	"example.com/go-engine/internal/raft"
	"example.com/go-engine/internal/wal"
)

func BootStorageNode(nodeID string) *wal.SegmentWriter {
	writer := wal.NewSegmentWriter()
	writer.Append([]byte("init"))
	filter := index.NewBloomFilter(256, 3)
	filter.Add([]byte("boot"))
	tracker := raft.NewElectionTracker(nodeID, 3)
	tracker.ResetTimer(150, 300, rand.New(rand.NewSource(1)))
	wal.CompactSegments([]wal.Mutation{{Key: "k", Value: []byte("v")}})
	return writer
}

func main() {
	BootStorageNode("node-1")
}
