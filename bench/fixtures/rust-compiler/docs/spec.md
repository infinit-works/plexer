# Wire Format Specification

Each serialized struct aligns scalar fields on 8-bit boundaries and tags
union discriminants in big-endian network order before fixed payload bytes.
