// web/src/types/ambient.d.ts
//
// Ambient declarations for browser APIs TypeScript's bundled lib.dom.d.ts does
// not yet model.
//
// These are declared rather than polyfilled, and the comments say where the real
// specification lives. Two of them are load-bearing for the architecture:
//
//   * `FileSystemDirectoryHandle.queryPermission/requestPermission` - Part 3.8's
//     whole storage story depends on re-granting a persisted handle after a
//     reload. It is a real, shipping Chromium API that lib.dom has not caught up
//     with.
//
//   * WebGPU types - Part 3.5's entire backend is WebGPU, and `@webgpu/types`
//     would be the upstream route. A local declaration keeps the dependency count
//     at zero for something that only covers what this project calls.
//
// If either ships in lib.dom later, delete the corresponding block here.

/** `'granted' | 'denied' | 'prompt'` */
type FileSystemPermissionState = 'granted' | 'denied' | 'prompt';

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemDirectoryHandle {
  /**
   * Moves or renames a file within this directory.
   *
   * This is the primitive that makes Part 3.8's atomic write possible: write to a
   * temp name, then move it over the real one. There is no `rename` on the
   * directory handle itself.
   */
  move?(name: string, targetDir: FileSystemDirectoryHandle, newName?: string): Promise<void>;

  /** Async iteration over this directory's entries. */
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>;

  /** Returns the current permission without prompting. Never throws. */
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<FileSystemPermissionState>;

  /**
   * Prompts for permission. Requires a user gesture, so it must never be called
   * from a boot path.
   */
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<FileSystemPermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: string | FileSystemHandle;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}

// Also declared as free globals, because the I/O worker reaches these through
// `self` rather than `window`: a worker has no `window`, so a Window-only
// declaration type-checks on the main thread and then fails to resolve in a
// worker. Declaring them here keeps both call sites honest.
declare var showDirectoryPicker:
  | undefined
  | ((options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>);

declare var showOpenFilePicker:
  | undefined
  | ((options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>);

// --- WebGPU ---------------------------------------------------------------
//
// A deliberately narrow slice: adapter description, limits, and the presence of
// an adapter. The full device/pipeline surface is not needed until Phase 2, and
// declaring it here would mean maintaining a copy of the spec.

type GPUAdapterInfo = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
  subgroupMinSize?: number;
  subgroupMaxSize?: number;
};

type GPUSupportedLimits = {
  maxBufferSize?: number;
  maxTextureDimension2D?: number;
  maxTextureDimension3D?: number;
  maxTextureDimensionCube?: number;
  maxTextureArrayLayers?: number;
  maxBindGroups?: number;
  maxBindingsPerBindGroup?: number;
  maxDynamicUniformBuffersPerPipelineLayout?: number;
  maxUniformBufferBindingSize?: number;
  maxStorageBufferBindingSize?: number;
  maxVertexBuffers?: number;
  maxVertexAttributes?: number;
  maxComputeWorkgroupStorageSize?: number;
  maxComputeInvocationsPerWorkgroup?: number;
};

type GPURequestAdapterOptions = {
  powerPreference?: 'low-power' | 'high-performance';
  forceFallbackAdapter?: boolean;
  xrCompatible?: boolean;
};

interface GPUAdapter {
  readonly isFallbackAdapter: boolean;
  readonly limits: GPUSupportedLimits;
  readonly features: ReadonlySet<string>;
  /** Shipped in Chromium 128+; the properties below are the older shape. */
  readonly info?: GPUAdapterInfo;
  requestAdapterInfo?(): Promise<GPUAdapterInfo>;
}

interface GPU {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<GPUAdapter | null>;
  getPreferredCanvasFormat?(): string;
}

interface Navigator {
  readonly gpu?: GPU;
}

/** AudioContext options; `latencyHint` is missing from older lib.dom versions. */
interface AudioContextOptions {
  latencyHint?: 'interactive' | 'balanced' | 'playback';
  sampleRate?: number;
}
