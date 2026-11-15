package wal

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
)

var ErrCorruptRecord = errors.New("wal: checksum mismatch on log record")

// Record represents a framed write-ahead log entry stored on disk.
type Record struct {
	Seq     uint64
	Payload []byte
}

// SegmentWriter appends framed records protected by IEEE CRC32 checksums.
type SegmentWriter struct {
	buf     []byte
	nextSeq uint64
}

func NewSegmentWriter() *SegmentWriter {
	return &SegmentWriter{nextSeq: 1}
}

func (w *SegmentWriter) Append(payload []byte) uint64 {
	seq := w.nextSeq
	w.nextSeq++
	header := make([]byte, 16)
	binary.LittleEndian.PutUint64(header[0:8], seq)
	binary.LittleEndian.PutUint32(header[8:12], uint32(len(payload)))
	binary.LittleEndian.PutUint32(header[12:16], crc32.ChecksumIEEE(payload))
	w.buf = append(w.buf, header...)
	w.buf = append(w.buf, payload...)
	return seq
}

func DecodeRecord(frame []byte) (Record, int, error) {
	if len(frame) < 16 {
		return Record{}, 0, ErrCorruptRecord
	}
	seq := binary.LittleEndian.Uint64(frame[0:8])
	size := int(binary.LittleEndian.Uint32(frame[8:12]))
	wantCRC := binary.LittleEndian.Uint32(frame[12:16])
	if len(frame) < 16+size {
		return Record{}, 0, ErrCorruptRecord
	}
	payload := frame[16 : 16+size]
	if crc32.ChecksumIEEE(payload) != wantCRC {
		return Record{}, 0, ErrCorruptRecord
	}
	return Record{Seq: seq, Payload: payload}, 16 + size, nil
}
