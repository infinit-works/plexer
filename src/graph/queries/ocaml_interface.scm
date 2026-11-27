; OCaml interface signatures (.mli)
(module_type_definition
  (module_type_name) @name) @definition.interface

(module_definition
  (module_binding (module_name) @name) @definition.module)

(type_definition
  (type_binding
    name: [
      (type_constructor) @name
      (type_constructor_path (type_constructor) @name)
    ]) @definition.type)

(value_specification
  (value_name) @name) @definition.function

(external
  (value_name) @name) @definition.function

(class_definition
  (class_binding (class_name) @name) @definition.class)

(class_type_definition
  (class_type_binding (class_type_name) @name) @definition.class)

(method_specification
  (method_name) @name) @definition.method

(module_path (module_name) @name) @reference.module
(module_type_path (module_type_name) @name) @reference.implementation
(type_constructor_path (type_constructor) @name) @reference.class
