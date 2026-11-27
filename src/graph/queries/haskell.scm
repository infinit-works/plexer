; Haskell tags
(module
  (module_id) @name) @definition.module

(function
  name: (variable) @name) @definition.function

(signature
  name: (variable) @name) @definition.function

(data_type
  name: (name) @name) @definition.struct

(newtype
  name: (name) @name) @definition.type

(type_synomym
  name: (name) @name) @definition.type

(class
  name: (name) @name) @definition.interface

(apply
  function: [
    (variable) @name
    (qualified (variable) @name)
  ]) @reference.call
