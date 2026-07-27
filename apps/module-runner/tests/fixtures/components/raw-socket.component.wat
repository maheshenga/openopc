(component
  (import "wasi:sockets/tcp@0.2.0" (instance $tcp))
  (core module $implementation
    (func (export "run") (result i32) (i32.const 0))
  )
  (core instance $instance (instantiate $implementation))
  (func (export "run") (result u32) (canon lift (core func $instance "run")))
)
