(component
  (core module $implementation
    (memory 1)
    (func (export "run") (result i32)
      (drop (memory.grow (i32.const 32)))
      (i32.const 0)
    )
  )
  (core instance $instance (instantiate $implementation))
  (func (export "run") (result u32) (canon lift (core func $instance "run")))
)
