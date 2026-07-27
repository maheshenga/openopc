(component
  (import "openopc:module/output@1.0.0"
    (instance $output
      (export "write-byte" (func (param "value" u8) (result u32)))
    )
  )
  (core module $implementation
    (import "" "write-byte" (func $write-byte (param i32) (result i32)))
    (func (export "run") (result i32)
      (drop (call $write-byte (i32.const 65)))
      (drop (call $write-byte (i32.const 66)))
      (i32.const 0)
    )
  )
  (core func $write-byte (canon lower (func $output "write-byte")))
  (core instance $instance
    (instantiate $implementation
      (with "" (instance (export "write-byte" (func $write-byte))))
    )
  )
  (func (export "run") (result u32) (canon lift (core func $instance "run")))
)
