; Terraform / HCL tags
; resource / data / module / variable / output / locals handled with type+label extras in generic.js where needed;
; keep structural captures here for calls and attribute references.
(function_call
  (identifier) @name) @reference.call

(expression
  (variable_expr (identifier) @name)
  (get_attr)) @reference.class
