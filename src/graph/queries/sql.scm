; SQL DDL / DML tags
(create_table
  (object_reference name: (identifier) @name)) @definition.struct

(create_view
  (object_reference name: (identifier) @name)) @definition.type

(create_materialized_view
  (object_reference name: (identifier) @name)) @definition.type

(create_function
  (object_reference name: (identifier) @name)) @definition.function

(create_trigger
  (object_reference name: (identifier) @name)) @definition.function

(create_index
  (identifier) @name) @definition.variable

(create_type
  (object_reference name: (identifier) @name)) @definition.type

(relation
  (object_reference name: (identifier) @name)) @reference.class

(column_definition
  (keyword_references)
  (object_reference name: (identifier) @name)) @reference.class
