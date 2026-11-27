; Objective-C / Objective-C++ tags
(protocol_declaration
  (identifier) @name) @definition.interface

(class_interface
  (identifier) @name) @definition.class

(class_implementation
  (identifier) @name) @definition.class

(method_definition
  (identifier) @name) @definition.method

(method_declaration
  (identifier) @name) @definition.method

(function_definition
  declarator: (function_declarator declarator: (identifier) @name)) @definition.function

(function_definition
  declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

(struct_specifier
  name: (type_identifier) @name body: (_)) @definition.struct

(enum_specifier
  name: (type_identifier) @name body: (_)) @definition.enum

(type_definition
  declarator: (type_identifier) @name) @definition.type

(message_expression
  method: (identifier) @name) @reference.call

(call_expression
  function: (identifier) @name) @reference.call
