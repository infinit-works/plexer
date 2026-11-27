; C# tags — minimal, matched to the tree-sitter-wasms c_sharp grammar node types.
; (Upstream tree-sitter-c-sharp tags.scm references node types the bundled wasm
;  grammar version lacks — "Bad node name 'type'" — so plexer ships this instead.)

(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.class
(delegate_declaration name: (identifier) @name) @definition.type
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.method
(property_declaration name: (identifier) @name) @definition.variable
(field_declaration (variable_declaration (variable_declarator name: (identifier) @name))) @definition.variable
(event_declaration name: (identifier) @name) @definition.variable
(namespace_declaration name: [ (identifier) @name (qualified_name) @name ]) @definition.module
(file_scoped_namespace_declaration name: [ (identifier) @name (qualified_name) @name ]) @definition.module

(invocation_expression
  function: [
    (identifier) @name
    (member_access_expression name: (identifier) @name)
  ]) @reference.call

(object_creation_expression
  type: [
    (identifier) @name
    (qualified_name name: (identifier) @name)
    (generic_name (identifier) @name)
  ]) @reference.call

(base_list [
  (identifier) @name
  (generic_name (identifier) @name)
]) @reference.class
