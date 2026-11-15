"""Length-prefixed JSON framing codec for bidirectional IPC pipes."""

import json
import struct
from typing import Any


class PipeCodec:
    """Encodes and decodes 4-byte length-prefixed JSON envelopes over pipes."""

    HEADER_FMT = ">I"
    HEADER_SIZE = 4

    def encode_envelope(self, payload: dict[str, Any]) -> bytes:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return struct.pack(self.HEADER_FMT, len(body)) + body

    def decode_envelope(self, buffer: bytes) -> tuple[dict[str, Any] | None, bytes]:
        if len(buffer) < self.HEADER_SIZE:
            return None, buffer
        (frame_len,) = struct.unpack(self.HEADER_FMT, buffer[: self.HEADER_SIZE])
        if len(buffer) < self.HEADER_SIZE + frame_len:
            return None, buffer
        raw = buffer[self.HEADER_SIZE : self.HEADER_SIZE + frame_len]
        return json.loads(raw.decode("utf-8")), buffer[self.HEADER_SIZE + frame_len :]
