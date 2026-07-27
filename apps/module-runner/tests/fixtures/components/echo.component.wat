(component
  (import "openopc:module/input@1.0.0"
    (instance $input
      (export "len" (func (result u64)))
      (export "read-byte" (func (param "offset" u64) (result u32)))
    )
  )
  (import "openopc:module/output@1.0.0"
    (instance $output
      (export "write-byte" (func (param "value" u8) (result u32)))
    )
  )

  (core module $implementation
    (import "" "len" (func $len (result i64)))
    (import "" "read-byte" (func $read-byte (param i64) (result i32)))
    (import "" "write-byte" (func $write-byte (param i32) (result i32)))

    (func (export "run") (result i32)
      (local $offset i64)
      (local $length i64)
      (local.set $length (call $len))
      (loop $copy
        (if (i64.ge_u (local.get $offset) (local.get $length))
          (then (return (i32.const 0)))
        )
        (drop
          (call $write-byte
            (call $read-byte (local.get $offset))
          )
        )
        (local.set $offset (i64.add (local.get $offset) (i64.const 1)))
        (br $copy)
      )
      (i32.const 0)
    )
  )

  (core func $len (canon lower (func $input "len")))
  (core func $read-byte (canon lower (func $input "read-byte")))
  (core func $write-byte (canon lower (func $output "write-byte")))
  (core instance $instance
    (instantiate $implementation
      (with "" (instance
        (export "len" (func $len))
        (export "read-byte" (func $read-byte))
        (export "write-byte" (func $write-byte))
      ))
    )
  )
  (func (export "run") (result u32) (canon lift (core func $instance "run")))
)
