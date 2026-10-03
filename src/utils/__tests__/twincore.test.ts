import {Platform} from 'react-native';
import {getBackendDevicesInfo, initLlama} from 'llama.rn';

import {
  TWINCORE_BIG_CPUS,
  TWINCORE_CPU_MASK,
  TWINCORE_N_THREADS,
  applyTwinCoreCpuPolicy,
  cpusToMask,
  initLlamaWithTwinCore,
  resolveTwinCoreBackendChain,
} from '../twincore';

const discover = getBackendDevicesInfo as jest.Mock;
const nativeInit = initLlama as jest.Mock;

const htp = (deviceName: string) => ({
  backend: 'HTP',
  type: 'accel',
  deviceName,
  maxMemorySize: 0,
});
const gpu = (deviceName: string) => ({
  backend: 'GPU',
  type: 'gpu',
  deviceName,
  maxMemorySize: 0,
});

describe('TwinCore runtime policy', () => {
  const originalOS = Platform.OS;

  beforeEach(() => {
    Platform.OS = 'android';
    discover.mockReset().mockResolvedValue([]);
    nativeInit.mockReset().mockResolvedValue({
      release: jest.fn().mockResolvedValue(undefined),
      isMultimodalEnabled: jest.fn().mockResolvedValue(false),
    });
  });

  afterEach(() => {
    Platform.OS = originalOS;
  });

  describe('cpusToMask', () => {
    it('packs CPU numbers into a hex mask', () => {
      // CPU 6 + 7 → 0b1100_0000. This is the whole point of the module:
      // ggml's matmul has a sync barrier, so the slowest thread sets the
      // round's latency and the little A55s only make it slower.
      expect(cpusToMask(TWINCORE_BIG_CPUS)).toBe(TWINCORE_CPU_MASK);
      expect(cpusToMask([0, 1, 2, 3])).toBe('0xF');
      expect(cpusToMask([])).toBe('0x0');
    });

    it('ignores CPU numbers outside the 32-core mask width', () => {
      // A 64-core device would otherwise shift past bit 31 and wrap, which
      // JS bitwise ops do silently — producing a mask that binds the wrong
      // cores rather than failing loudly.
      expect(cpusToMask([0, 63, -1])).toBe('0x1');
    });
  });

  describe('applyTwinCoreCpuPolicy', () => {
    it('pins the two big A75 cores on Android', () => {
      expect(applyTwinCoreCpuPolicy({n_threads: 8})).toMatchObject({
        n_threads: TWINCORE_N_THREADS,
        cpu_mask: TWINCORE_CPU_MASK,
        cpu_strict: true,
      });
    });

    it('overrides whatever the persisted settings or device rules asked for', () => {
      // The policy runs last, immediately before initLlama, precisely so it
      // wins over every upstream source. Without this the affinity fix would
      // silently regress the moment a user touched the thread slider.
      expect(
        applyTwinCoreCpuPolicy({n_threads: 6, cpu_mask: '0xFF'} as never),
      ).toMatchObject({n_threads: TWINCORE_N_THREADS, cpu_mask: '0xC0'});
    });

    it('leaves iOS alone apart from the forward-compat thread hint', () => {
      // n_threads_batch is set on both platforms on purpose: llama.rn
      // 0.13.0-rc.3's NativeContextParams doesn't have the field yet, so it's
      // a no-op today and inherits cpuparams anyway. It rides along so the
      // call site won't need changing if llama.rn adds it.
      Platform.OS = 'ios';
      expect(applyTwinCoreCpuPolicy({n_threads: 6})).toEqual({
        n_threads: 6,
        n_threads_batch: TWINCORE_N_THREADS,
      });
    });
  });

  describe('resolveTwinCoreBackendChain', () => {
    it('does not intervene off Android', async () => {
      Platform.OS = 'ios';
      discover.mockResolvedValue([htp('HTP0')]);
      expect(await resolveTwinCoreBackendChain()).toEqual([]);
    });

    it('prefers HTP, then OpenCL, and always ends on CPU', async () => {
      // SD 730's Hexagon 688 (HTP v3) is outside llama.rn's verified range
      // (SM8450+ / HTP v4+), so HTP is treated as "try it, don't trust it".
      discover.mockResolvedValue([gpu('Adreno (TM) 618'), htp('HTP0')]);
      expect(await resolveTwinCoreBackendChain()).toEqual([
        {label: 'Hexagon HTP', devices: ['HTP0'], n_gpu_layers: 99},
        {label: 'OpenCL GPU', devices: ['Adreno (TM) 618'], n_gpu_layers: 99},
        {label: 'CPU', devices: ['CPU'], n_gpu_layers: 0},
      ]);
    });

    it('skips wildcard HTP names that would bind nothing', async () => {
      discover.mockResolvedValue([htp('HTP*'), htp('HTP?'), htp('HTP2')]);
      const chain = await resolveTwinCoreBackendChain();
      expect(chain[0]).toEqual({
        label: 'Hexagon HTP',
        devices: ['HTP2'],
        n_gpu_layers: 99,
      });
    });

    it('falls back to CPU alone when nothing is reported', async () => {
      discover.mockResolvedValue([]);
      expect(await resolveTwinCoreBackendChain()).toEqual([
        {label: 'CPU', devices: ['CPU'], n_gpu_layers: 0},
      ]);
    });

    it('zeroes n_gpu_layers on the CPU hop only', async () => {
      // n_gpu_layers > 0 with devices=['CPU'] makes llama.cpp keep trying to
      // offload layers to a backend that isn't there — verified on Snapdragon
      // 8 Elite Gen 5. CPU must therefore carry 0, accelerators carry 99.
      discover.mockResolvedValue([gpu('Adreno'), htp('HTP0')]);
      const chain = await resolveTwinCoreBackendChain();
      expect(chain.map(h => h.n_gpu_layers)).toEqual([99, 99, 0]);
    });
  });

  describe('initLlamaWithTwinCore', () => {
    it('stops at the first backend that initialises', async () => {
      discover.mockResolvedValue([htp('HTP0'), gpu('Adreno')]);
      await initLlamaWithTwinCore({model: '/m.gguf'});
      expect(nativeInit).toHaveBeenCalledTimes(1);
      expect(nativeInit.mock.calls[0][0]).toMatchObject({
        devices: ['HTP0'],
        n_gpu_layers: 99,
        n_threads: TWINCORE_N_THREADS,
        cpu_mask: TWINCORE_CPU_MASK,
      });
    });

    it('walks down the chain instead of crashing when a backend fails', async () => {
      // The whole reason this layer exists: a Hexagon init failure must not
      // take the app down. It degrades one tier and keeps going.
      discover.mockResolvedValue([htp('HTP0'), gpu('Adreno')]);
      nativeInit
        .mockRejectedValueOnce(new Error('HTP unavailable'))
        .mockRejectedValueOnce(new Error('OpenCL unsupported'))
        .mockResolvedValueOnce({
          release: jest.fn(),
          isMultimodalEnabled: jest.fn(),
        });

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      await initLlamaWithTwinCore({model: '/m.gguf'});
      warn.mockRestore();

      expect(nativeInit).toHaveBeenCalledTimes(3);
      expect(nativeInit.mock.calls.map(c => c[0].devices)).toEqual([
        ['HTP0'],
        ['Adreno'],
        ['CPU'],
      ]);
      expect(nativeInit.mock.calls[2][0]).toMatchObject({n_gpu_layers: 0});
    });

    it('rethrows only after every backend has failed', async () => {
      discover.mockResolvedValue([]);
      nativeInit.mockRejectedValue(new Error('every backend failed'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(initLlamaWithTwinCore({model: '/m.gguf'})).rejects.toThrow(
        'every backend failed',
      );
      warn.mockRestore();
    });

    it('bypasses the chain entirely off Android', async () => {
      // iOS has no chain, so the caller's own devices/n_gpu_layers must reach
      // llama.rn untouched — Metal handles offload itself.
      Platform.OS = 'ios';
      await initLlamaWithTwinCore({
        model: '/m.gguf',
        devices: ['Metal'],
        n_gpu_layers: 99,
      });
      expect(discover).not.toHaveBeenCalled();
      expect(nativeInit).toHaveBeenCalledTimes(1);
      expect(nativeInit.mock.calls[0][0]).toMatchObject({
        devices: ['Metal'],
        n_gpu_layers: 99,
      });
    });
  });
});
