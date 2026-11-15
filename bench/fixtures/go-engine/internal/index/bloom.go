package index

import "hash/fnv"

// BloomFilter provides probabilistic set membership tests to skip unnecessary
// disk table lookups when a requested key is guaranteed absent.
type BloomFilter struct {
	bits   []byte
	numBit uint64
	hashes uint64
}

func NewBloomFilter(numBytes int, hashes uint64) *BloomFilter {
	return &BloomFilter{
		bits:   make([]byte, numBytes),
		numBit: uint64(numBytes) * 8,
		hashes: hashes,
	}
}

func pairDigest(key []byte) (uint64, uint64) {
	h1 := fnv.New64a()
	h1.Write(key)
	a := h1.Sum64()
	b := (a >> 32) | (a << 32) | 1
	return a, b
}

func (bf *BloomFilter) Add(key []byte) {
	h1, h2 := pairDigest(key)
	for i := uint64(0); i < bf.hashes; i++ {
		bit := (h1 + i*h2) % bf.numBit
		bf.bits[bit/8] |= 1 << (bit % 8)
	}
}

func (bf *BloomFilter) MayContain(key []byte) bool {
	h1, h2 := pairDigest(key)
	for i := uint64(0); i < bf.hashes; i++ {
		bit := (h1 + i*h2) % bf.numBit
		if bf.bits[bit/8]&(1<<(bit%8)) == 0 {
			return false
		}
	}
	return true
}
