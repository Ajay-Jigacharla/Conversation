declare module "@echogarden/fvad-wasm" {
  interface FvadModule {
    ready: Promise<FvadModule>;
    _fvad_new(): number;
    _fvad_free(inst: number): void;
    _fvad_reset(inst: number): void;
    _fvad_set_mode(inst: number, mode: number): void;
    _fvad_set_sample_rate(inst: number, rate: number): void;
    _fvad_process(inst: number, bufferPtr: number, length: number): number;
    _malloc(size: number): number;
    _free(ptr: number): void;
    HEAP16: Int16Array;
    [key: string]: any;
  }

  const factory: () => Promise<FvadModule>;
  export default factory;
}
