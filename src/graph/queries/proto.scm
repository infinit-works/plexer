; Protobuf tags
(message
  (message_name (identifier) @name)) @definition.struct

(enum
  (enum_name (identifier) @name)) @definition.enum

(service
  (service_name (identifier) @name)) @definition.interface

(rpc
  (rpc_name (identifier) @name)) @definition.method

(message_or_enum_type
  (identifier) @name) @reference.class
