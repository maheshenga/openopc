use thiserror::Error;
use wasmtime::{ResourceLimiter, Result as WasmtimeResult};

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum WasiLimitError {
    #[error("WASI_MEMORY_LIMIT")]
    Memory,
    #[error("WASI_TABLE_LIMIT")]
    Table,
    #[error("WASI_OUTPUT_LIMIT")]
    Output,
}

pub struct WasiStoreLimits {
    memory_bytes: usize,
    table_elements: usize,
}

impl WasiStoreLimits {
    pub fn new(memory_bytes: usize, table_elements: usize) -> Self {
        Self {
            memory_bytes,
            table_elements,
        }
    }
}

impl ResourceLimiter for WasiStoreLimits {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> WasmtimeResult<bool> {
        if desired > self.memory_bytes || maximum.is_some_and(|maximum| desired > maximum) {
            return Err(wasmtime::Error::new(WasiLimitError::Memory));
        }
        Ok(true)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        maximum: Option<usize>,
    ) -> WasmtimeResult<bool> {
        if desired > self.table_elements || maximum.is_some_and(|maximum| desired > maximum) {
            return Err(wasmtime::Error::new(WasiLimitError::Table));
        }
        Ok(true)
    }

    fn instances(&self) -> usize {
        16
    }

    fn tables(&self) -> usize {
        8
    }

    fn memories(&self) -> usize {
        8
    }
}
