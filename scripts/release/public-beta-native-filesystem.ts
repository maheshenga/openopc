import { FFIType, dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { randomUUID } from 'node:crypto';

export type PublicBetaNativeDirectory = Readonly<{
  readonly kind: 'directory';
  readonly token: symbol;
}>;

export type PublicBetaNativeFile = Readonly<{
  readonly kind: 'file';
  readonly token: symbol;
}>;

export interface PublicBetaNativeFilesystem {
  openDirectory(path: string): PublicBetaNativeDirectory | false;
  createPrivateDirectory(
    parent: PublicBetaNativeDirectory,
    prefix: string,
  ): PublicBetaNativeDirectory | false;
  writeExclusiveFile(
    directory: PublicBetaNativeDirectory,
    name: string,
    bytes: Uint8Array,
  ): PublicBetaNativeFile | false;
  retainExistingRegularFile(
    directory: PublicBetaNativeDirectory,
    name: string,
  ): PublicBetaNativeFile | false;
  readFile(file: PublicBetaNativeFile, maxBytes: number): Uint8Array | false;
  closeFile(file: PublicBetaNativeFile): boolean;
  childPath(directory: PublicBetaNativeDirectory, name: string): string | false;
  exactRegularFiles(directory: PublicBetaNativeDirectory, expected: readonly string[]): boolean;
  publishNoReplace(
    source: PublicBetaNativeDirectory,
    destination: PublicBetaNativeDirectory,
    finalName: string,
    authorizeSource: () => boolean,
  ): boolean;
  disposeUnpublished(
    directory: PublicBetaNativeDirectory,
    expectedNames: readonly string[],
  ): 'removed' | 'retained';
  closeDirectory(directory: PublicBetaNativeDirectory): boolean;
}

type AnyNativeFunction = (...args: readonly unknown[]) => unknown;
type NativeLibrary = {
  symbols: Record<string, AnyNativeFunction>;
  close(): void;
};

const INVALID_HANDLE_VALUE = 0xffffffffffffffff;
const WINDOWS_FILE_ATTRIBUTE_DIRECTORY = 0x10;
const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const WINDOWS_FILE_LIST_DIRECTORY = 0x0001;
const WINDOWS_FILE_ADD_FILE = 0x0002;
const WINDOWS_FILE_ADD_SUBDIRECTORY = 0x0004;
const WINDOWS_FILE_TRAVERSE = 0x0020;
const WINDOWS_FILE_DELETE_CHILD = 0x0040;
const WINDOWS_FILE_READ_ATTRIBUTES = 0x0080;
const WINDOWS_FILE_WRITE_ATTRIBUTES = 0x0100;
const WINDOWS_DELETE = 0x00010000;
const WINDOWS_SYNCHRONIZE = 0x00100000;
const WINDOWS_GENERIC_READ = 0x80000000;
const WINDOWS_GENERIC_WRITE = 0x40000000;
const WINDOWS_FILE_SHARE_READ = 0x00000001;
const WINDOWS_FILE_SHARE_WRITE = 0x00000002;
const WINDOWS_FILE_SHARE_DELETE = 0x00000004;
const WINDOWS_OPEN_EXISTING = 3;
const WINDOWS_FILE_CREATE = 2;
const WINDOWS_READ_CONTROL = 0x00020000;
const WINDOWS_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const WINDOWS_FILE_DIRECTORY_FILE = 0x00000001;
const WINDOWS_FILE_NON_DIRECTORY_FILE = 0x00000040;
const WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const WINDOWS_FILE_OPEN_REPARSE_POINT = 0x00000200;
const WINDOWS_FILE_BEGIN = 0;
const WINDOWS_FILE_ID_BOTH_DIRECTORY_INFORMATION = 2;
const WINDOWS_FILE_RENAME_INFO_EX = 22;
const WINDOWS_FILE_DISPOSITION_INFO_EX = 64;
const WINDOWS_FILE_DISPOSITION_DELETE = 0x00000001;
const WINDOWS_FILE_DISPOSITION_POSIX_SEMANTICS = 0x00000002;
const WINDOWS_FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE = 0x00000010;
const WINDOWS_STATUS_SUCCESS = 0;
const WINDOWS_STATUS_NO_MORE_FILES = -2147483642;

const LINUX_O_RDONLY = 0;
const LINUX_O_WRONLY = 1;
const LINUX_O_CREAT = 0x40;
const LINUX_O_EXCL = 0x80;
const LINUX_O_CLOEXEC = 0x80000;
const LINUX_O_DIRECTORY = 0x10000;
const LINUX_O_NOFOLLOW = 0x20000;
const LINUX_AT_REMOVEDIR = 0x200;
const LINUX_AT_SYMLINK_NOFOLLOW = 0x100;
const LINUX_RENAME_NOREPLACE = 1;
const LINUX_SYS_GETDENTS64 = 217;
const LINUX_DT_REG = 8;
const LINUX_S_IFMT = 0o170000;
const LINUX_S_IFREG = 0o100000;
const LINUX_S_IFDIR = 0o040000;
const LINUX_MAX_NATIVE_BYTES = 0x7fffffff;

function unsupportedFilesystem(): PublicBetaNativeFilesystem {
  return {
    openDirectory: () => false,
    createPrivateDirectory: () => false,
    writeExclusiveFile: () => false,
    retainExistingRegularFile: () => false,
    readFile: () => false,
    closeFile: () => false,
    childPath: () => false,
    exactRegularFiles: () => false,
    publishNoReplace: () => false,
    disposeUnpublished: () => 'retained',
    closeDirectory: () => false,
  };
}

function opaqueDirectory(): PublicBetaNativeDirectory {
  return Object.freeze({ kind: 'directory', token: Symbol('public-beta-directory') });
}

function opaqueFile(): PublicBetaNativeFile {
  return Object.freeze({ kind: 'file', token: Symbol('public-beta-file') });
}

function validName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 240 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\u0000')
  );
}

function validPrefix(prefix: string): boolean {
  return prefix.length > 0 && prefix.length <= 64 && /^[A-Za-z0-9._-]+$/.test(prefix);
}

function validBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength <= LINUX_MAX_NATIVE_BYTES;
}

function utf16(value: string, nulTerminated = false): Uint16Array {
  const result = new Uint16Array(value.length + (nulTerminated ? 1 : 0));
  for (let index = 0; index < value.length; index += 1) result[index] = value.charCodeAt(index);
  return result;
}

function readWindowsAttributes(
  kernel32: NativeLibrary,
  handle: number,
): { attributes: number; reparseTag: number } | false {
  const buffer = new Uint8Array(8);
  try {
    const ok = kernel32.symbols.GetFileInformationByHandleEx(handle, 9, ptr(buffer), buffer.byteLength);
    if (!ok) return false;
    const view = new DataView(buffer.buffer);
    return { attributes: view.getUint32(0, true), reparseTag: view.getUint32(4, true) };
  } catch {
    return false;
  }
}

function windowsIdentity(
  kernel32: NativeLibrary,
  handle: number,
): { volume: number; index: bigint; attributes: number } | false {
  const buffer = new Uint8Array(52);
  try {
    if (!kernel32.symbols.GetFileInformationByHandle(handle, ptr(buffer))) return false;
    const view = new DataView(buffer.buffer);
    return {
      attributes: view.getUint32(0, true),
      volume: view.getUint32(28, true),
      index: view.getBigUint64(44, true),
    };
  } catch {
    return false;
  }
}

function sameWindowsIdentity(
  left: { volume: number; index: bigint },
  right: { volume: number; index: bigint },
): boolean {
  return left.volume === right.volume && left.index === right.index;
}

function loadWindowsLibraries(): {
  ntdll: NativeLibrary;
  kernel32: NativeLibrary;
  advapi32: NativeLibrary;
} | false {
  try {
    const ntdll = dlopen('ntdll.dll', {
      NtCreateFile: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      NtQueryDirectoryFile: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.bool, FFIType.ptr, FFIType.bool],
        returns: FFIType.i32,
      },
      NtSetInformationFile: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32],
        returns: FFIType.i32,
      },
      NtClose: { args: [FFIType.ptr], returns: FFIType.i32 },
      RtlInitUnicodeString: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    }) as unknown as NativeLibrary;
    const kernel32 = dlopen('kernel32.dll', {
      CreateFileW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
        returns: FFIType.ptr,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
      WriteFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      ReadFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      SetFilePointerEx: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      GetFileSizeEx: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr },
      GetFileInformationByHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      GetFileInformationByHandleEx: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      SetFileInformationByHandle: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.bool },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
    }) as unknown as NativeLibrary;
    const advapi32 = dlopen('advapi32.dll', {
      ConvertStringSecurityDescriptorToSecurityDescriptorW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
      OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
      GetTokenInformation: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
      ConvertSidToStringSidW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      GetKernelObjectSecurity: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
      ConvertSecurityDescriptorToStringSecurityDescriptorW: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.bool,
      },
    }) as unknown as NativeLibrary;
    return { ntdll, kernel32, advapi32 };
  } catch {
    return false;
  }
}

function windowsObjectAttributes(
  ntdll: NativeLibrary,
  name: string,
  rootDirectory: number | null,
  securityDescriptor: number | null,
): { objectAttributes: Uint8Array; unicode: Uint8Array; nameBuffer: Uint16Array } {
  const nameBuffer = utf16(name, true);
  const unicode = new Uint8Array(16);
  ntdll.symbols.RtlInitUnicodeString(ptr(unicode), ptr(nameBuffer));
  const objectAttributes = new Uint8Array(48);
  const view = new DataView(objectAttributes.buffer);
  view.setUint32(0, 48, true);
  view.setBigUint64(8, BigInt(rootDirectory ?? 0), true);
  view.setBigUint64(16, BigInt(ptr(unicode)), true);
  view.setUint32(24, 0x40, true);
  view.setBigUint64(32, BigInt(securityDescriptor ?? 0), true);
  return { objectAttributes, unicode, nameBuffer };
}

function windowsSecurityDescriptor(
  advapi32: NativeLibrary,
  kernel32: NativeLibrary,
): { pointer: number; owner: Uint16Array; result: Uint8Array; sid: string } | false {
  const tokenOutput = new BigUint64Array(1);
  let tokenHandle = 0;
  let sidPointer = 0;
  let sidStringPointer = 0;
  let owner = utf16('D:P(A;;FA;;;SY)(A;;FA;;;OW)', true);
  const result = new Uint8Array(8);
  const size = new Uint8Array(4);
  try {
    const processHandle = kernel32.symbols.GetCurrentProcess();
    if (!advapi32.symbols.OpenProcessToken(processHandle, 0x0008, ptr(tokenOutput))) return false;
    tokenHandle = Number(tokenOutput[0]);
    if (tokenHandle === 0) return false;
    const required = new Uint8Array(4);
    advapi32.symbols.GetTokenInformation(tokenHandle, 1, null, 0, ptr(required));
    const tokenUserSize = new DataView(required.buffer).getUint32(0, true);
    if (tokenUserSize < 8 || tokenUserSize > 64 * 1024) return false;
    const tokenUser = new Uint8Array(tokenUserSize);
    if (!advapi32.symbols.GetTokenInformation(tokenHandle, 1, ptr(tokenUser), tokenUser.byteLength, ptr(required))) return false;
    sidPointer = Number(new DataView(tokenUser.buffer).getBigUint64(0, true));
    if (sidPointer === 0) return false;
    const sidOutput = new BigUint64Array(1);
    if (!advapi32.symbols.ConvertSidToStringSidW(sidPointer, ptr(sidOutput))) return false;
    sidStringPointer = Number(sidOutput[0]);
    if (sidStringPointer === 0) return false;
    const sidBytes = new Uint8Array(toArrayBuffer(sidStringPointer, 0, 256));
    let sid = '';
    for (let index = 0; index + 1 < sidBytes.byteLength; index += 2) {
      const code = new DataView(sidBytes.buffer).getUint16(index, true);
      if (code === 0) break;
      sid += String.fromCharCode(code);
    }
    if (!/^S-1-[0-9-]+$/.test(sid)) return false;
    owner = utf16(`D:P(A;;FA;;;SY)(A;;FA;;;${sid})`, true);
    if (!advapi32.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(owner), 1, ptr(result), ptr(size))) return false;
    const pointer = Number(new DataView(result.buffer).getBigUint64(0, true));
    return pointer === 0 ? false : { pointer, owner, result, sid };
  } catch {
    return false;
  } finally {
    if (sidStringPointer !== 0) kernel32.symbols.LocalFree(sidStringPointer);
    if (tokenHandle !== 0) kernel32.symbols.CloseHandle(tokenHandle);
  }
}

function readWideLocalString(kernel32: NativeLibrary, pointerValue: number, maxBytes: number): string | false {
  if (pointerValue === 0 || maxBytes <= 0 || maxBytes > 16 * 1024) return false;
  try {
    const bytes = new Uint8Array(toArrayBuffer(pointerValue, 0, maxBytes));
    const view = new DataView(bytes.buffer);
    let value = '';
    for (let index = 0; index + 1 < bytes.byteLength; index += 2) {
      const code = view.getUint16(index, true);
      if (code === 0) break;
      value += String.fromCharCode(code);
    }
    return value.length > 0 ? value : false;
  } catch {
    return false;
  } finally {
    kernel32.symbols.LocalFree(pointerValue);
  }
}

function verifyWindowsPrivateDacl(
  advapi32: NativeLibrary,
  kernel32: NativeLibrary,
  handle: number,
  expectedSid: string,
): boolean {
  const daclSecurityInformation = 0x00000004;
  const securityInformation = daclSecurityInformation;
  const needed = new Uint8Array(4);
  try {
    advapi32.symbols.GetKernelObjectSecurity(handle, securityInformation, null, 0, ptr(needed));
    const size = new DataView(needed.buffer).getUint32(0, true);
    if (size < 20 || size > 64 * 1024) return false;
    const descriptor = new Uint8Array(size);
    if (!advapi32.symbols.GetKernelObjectSecurity(handle, securityInformation, ptr(descriptor), descriptor.byteLength, ptr(needed))) return false;
    const stringPointer = new BigUint64Array(1);
    const stringLength = new Uint8Array(4);
    if (
      !advapi32.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorW(
        ptr(descriptor),
        1,
        securityInformation,
        ptr(stringPointer),
        ptr(stringLength),
      )
    ) {
      return false;
    }
    const descriptorText = readWideLocalString(kernel32, Number(stringPointer[0]), 16 * 1024);
    if (descriptorText === false) return false;
    return (
      descriptorText.includes('D:P') &&
      descriptorText.includes('SY') &&
      (descriptorText.includes(expectedSid) || descriptorText.includes(';;;OW') || descriptorText.includes(';;;LA')) &&
      !descriptorText.includes(';;;WD') &&
      !descriptorText.includes(';;;BU') &&
      !descriptorText.includes(';;;BA')
    );
  } catch {
    return false;
  }
}

type WindowsDirectoryState = {
  handle: number;
  path: string;
  parentToken: symbol | null;
  parentHandle: number | null;
  parentName: string | null;
  identity: { volume: number; index: bigint };
  files: Map<string, { identity: { volume: number; index: bigint }; handle: number | null }>;
  published: boolean;
};

type WindowsFileState = {
  handle: number;
  directory: symbol;
  identity: { volume: number; index: bigint };
};

function createWindowsFilesystem(libraries: {
  ntdll: NativeLibrary;
  kernel32: NativeLibrary;
  advapi32: NativeLibrary;
}): PublicBetaNativeFilesystem {
  const { ntdll, kernel32, advapi32 } = libraries;
  const directories = new Map<symbol, WindowsDirectoryState>();
  const files = new Map<symbol, WindowsFileState>();

  const closeNative = (handle: number): boolean => {
    try {
      return Boolean(kernel32.symbols.CloseHandle(handle));
    } catch {
      return false;
    }
  };

  const openRelative = (
    parent: WindowsDirectoryState,
    name: string,
    directory: boolean,
    create: boolean,
  ): { handle: number; identity: { volume: number; index: bigint; attributes: number } } | false => {
    const descriptor = create ? windowsSecurityDescriptor(advapi32, kernel32) : false;
    if (create && descriptor === false) return false;
    let descriptorPointer = descriptor === false ? 0 : descriptor.pointer;
    let handle = 0;
    const output = new BigUint64Array(1);
    const statusBlock = new Uint8Array(16);
    const desiredAccess = directory
      ? WINDOWS_FILE_LIST_DIRECTORY |
        WINDOWS_FILE_ADD_FILE |
        WINDOWS_FILE_ADD_SUBDIRECTORY |
        WINDOWS_FILE_TRAVERSE |
        WINDOWS_FILE_DELETE_CHILD |
        WINDOWS_FILE_READ_ATTRIBUTES |
        WINDOWS_FILE_WRITE_ATTRIBUTES |
        WINDOWS_DELETE |
        WINDOWS_READ_CONTROL |
        WINDOWS_SYNCHRONIZE
      : create
        ? 0x0001 |
          0x0002 |
          0x0004 |
          WINDOWS_DELETE |
          WINDOWS_SYNCHRONIZE |
          WINDOWS_FILE_READ_ATTRIBUTES |
          WINDOWS_FILE_WRITE_ATTRIBUTES
        : 0x0001 | WINDOWS_DELETE | WINDOWS_SYNCHRONIZE | WINDOWS_FILE_READ_ATTRIBUTES;
    const shareAccess = directory || !create
      ? WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE | WINDOWS_FILE_SHARE_DELETE
      : WINDOWS_FILE_SHARE_READ;
    try {
      const { objectAttributes, unicode, nameBuffer } = windowsObjectAttributes(
        ntdll,
        name,
        parent.handle,
        create ? descriptorPointer : null,
      );
      const status = ntdll.symbols.NtCreateFile(
        ptr(output),
        desiredAccess,
        ptr(objectAttributes),
        ptr(statusBlock),
        null,
        0x80,
        shareAccess,
        create ? WINDOWS_FILE_CREATE : 1,
        (directory ? WINDOWS_FILE_DIRECTORY_FILE : WINDOWS_FILE_NON_DIRECTORY_FILE) |
          WINDOWS_FILE_SYNCHRONOUS_IO_NONALERT |
          (create ? 0 : WINDOWS_FILE_OPEN_REPARSE_POINT),
        null,
        0,
      );
      void unicode;
      void nameBuffer;
      if (status !== WINDOWS_STATUS_SUCCESS || output[0] === 0n) return false;
      handle = Number(output[0]);
      const attributes = readWindowsAttributes(kernel32, handle);
      const identity = windowsIdentity(kernel32, handle);
      if (attributes === false || identity === false || (attributes.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) return false;
      if (directory !== ((attributes.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) !== 0)) return false;
      if (
        directory &&
        create &&
        (descriptor === false || !verifyWindowsPrivateDacl(advapi32, kernel32, handle, descriptor.sid))
      ) {
        return false;
      }
      const retainedHandle = handle;
      handle = 0;
      return { handle: retainedHandle, identity };
    } catch {
      return false;
    } finally {
      if (descriptorPointer !== 0) {
        kernel32.symbols.LocalFree(descriptorPointer);
        descriptorPointer = 0;
      }
      if (handle !== 0) closeNative(handle);
    }
  };

  const enumerate = (directory: WindowsDirectoryState): string[] | false => {
    const buffer = new Uint8Array(64 * 1024);
    const statusBlock = new Uint8Array(16);
    const names: string[] = [];
    try {
      const status = ntdll.symbols.NtQueryDirectoryFile(
        directory.handle,
        null,
        null,
        null,
        ptr(statusBlock),
        ptr(buffer),
        buffer.byteLength,
        WINDOWS_FILE_ID_BOTH_DIRECTORY_INFORMATION,
        false,
        null,
        true,
      );
      if (status !== WINDOWS_STATUS_SUCCESS && status !== WINDOWS_STATUS_NO_MORE_FILES) return false;
      if (status === WINDOWS_STATUS_NO_MORE_FILES) return names;
      let offset = 0;
      while (offset + 68 <= buffer.byteLength) {
        const view = new DataView(buffer.buffer, offset);
        const next = view.getUint32(0, true);
        const attributes = view.getUint32(56, true);
        const nameLength = view.getUint32(60, true);
        if (nameLength % 2 !== 0 || 68 + nameLength > buffer.byteLength - offset) return false;
        let name = '';
        for (let index = 0; index < nameLength; index += 2) name += String.fromCharCode(view.getUint16(68 + index, true));
        if (name !== '.' && name !== '..') {
          if ((attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) !== 0 || (attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) return false;
          names.push(name);
        }
        if (next === 0) break;
        if (next % 8 !== 0 || offset + next >= buffer.byteLength) return false;
        offset += next;
      }
      return names;
    } catch {
      return false;
    }
  };

  const exact = (directory: WindowsDirectoryState, expected: readonly string[]): boolean => {
    if (expected.some((name) => !validName(name)) || new Set(expected).size !== expected.length) return false;
    const names = enumerate(directory);
    if (names === false || names.length !== expected.length) return false;
    const expectedSet = new Set(expected);
    if (!names.every((name) => expectedSet.has(name))) return false;
    for (const name of expected) {
      const retained = directory.files.get(name);
      if (retained === undefined) return false;
      if (retained.handle !== null) {
        const current = windowsIdentity(kernel32, retained.handle);
        if (current === false || !sameWindowsIdentity(retained.identity, current)) return false;
        continue;
      }
      const rebound = openRelative(directory, name, false, false);
      if (rebound === false) return false;
      try {
        if (!sameWindowsIdentity(retained.identity, rebound.identity)) return false;
      } finally {
        closeNative(rebound.handle);
      }
    }
    return true;
  };

  return {
    openDirectory(path) {
      if (typeof path !== 'string' || path.length === 0) return false;
      const pathBuffer = utf16(path, true);
      const handle = kernel32.symbols.CreateFileW(
        ptr(pathBuffer),
        WINDOWS_GENERIC_READ | WINDOWS_GENERIC_WRITE | WINDOWS_DELETE | WINDOWS_SYNCHRONIZE,
        WINDOWS_FILE_SHARE_READ | WINDOWS_FILE_SHARE_WRITE | WINDOWS_FILE_SHARE_DELETE,
        null,
        WINDOWS_OPEN_EXISTING,
        WINDOWS_FILE_FLAG_BACKUP_SEMANTICS | WINDOWS_FILE_FLAG_OPEN_REPARSE_POINT,
        null,
      );
      if (handle === INVALID_HANDLE_VALUE || handle === 0) return false;
      const attributes = readWindowsAttributes(kernel32, handle);
      const identity = windowsIdentity(kernel32, handle);
      if (
        attributes === false ||
        identity === false ||
        (attributes.attributes & WINDOWS_FILE_ATTRIBUTE_DIRECTORY) === 0 ||
        (attributes.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0
      ) {
        closeNative(handle);
        return false;
      }
      const token = opaqueDirectory();
      directories.set(token.token, {
        handle,
        path,
        parentToken: null,
        parentHandle: null,
        parentName: null,
        identity,
        files: new Map(),
        published: false,
      });
      return token;
    },

    createPrivateDirectory(parentToken, prefix) {
      const parent = directories.get(parentToken.token);
      if (parent === undefined || !validPrefix(prefix) || parent.published) return false;
      const name = `${prefix}${randomUUID().replaceAll('-', '')}`;
      const created = openRelative(parent, name, true, true);
      if (created === false) return false;
      const token = opaqueDirectory();
      directories.set(token.token, {
        handle: created.handle,
        path: `${parent.path}\\${name}`,
        parentToken: parentToken.token,
        parentHandle: parent.handle,
        parentName: name,
        identity: created.identity,
        files: new Map(),
        published: false,
      });
      return token;
    },

    writeExclusiveFile(directoryToken, name, bytes) {
      const directory = directories.get(directoryToken.token);
      if (directory === undefined || directory.published || !validName(name) || !validBytes(bytes)) return false;
      const created = openRelative(directory, name, false, true);
      if (created === false) return false;
      const count = new Uint32Array(1);
      let written = false;
      try {
        written = bytes.byteLength === 0
          ? true
          : Boolean(kernel32.symbols.WriteFile(created.handle, ptr(bytes), bytes.byteLength, ptr(count), null)) && count[0] === bytes.byteLength;
      } catch {
        written = false;
      }
      if (!written) {
        closeNative(created.handle);
        return false;
      }
      const token = opaqueFile();
      files.set(token.token, { handle: created.handle, directory: directoryToken.token, identity: created.identity });
      directory.files.set(name, { identity: created.identity, handle: created.handle });
      return token;
    },

    retainExistingRegularFile(directoryToken, name) {
      const directory = directories.get(directoryToken.token);
      if (directory === undefined || directory.published || !validName(name)) return false;
      const existing = openRelative(directory, name, false, false);
      if (existing === false) return false;
      const identity = { volume: existing.identity.volume, index: existing.identity.index };
      const token = opaqueFile();
      files.set(token.token, { handle: existing.handle, directory: directoryToken.token, identity });
      directory.files.set(name, { identity, handle: existing.handle });
      return token;
    },

    readFile(fileToken, maxBytes) {
      const file = files.get(fileToken.token);
      if (file === undefined || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > LINUX_MAX_NATIVE_BYTES) return false;
      const directory = directories.get(file.directory);
      if (directory === undefined) return false;
      const current = windowsIdentity(kernel32, file.handle);
      if (current === false || !sameWindowsIdentity(file.identity, current)) return false;
      const sizeBuffer = new BigInt64Array(1);
      try {
        if (!kernel32.symbols.GetFileSizeEx(file.handle, ptr(sizeBuffer))) return false;
      } catch {
        return false;
      }
      if (sizeBuffer[0] < 0n || sizeBuffer[0] > BigInt(maxBytes) || sizeBuffer[0] > BigInt(LINUX_MAX_NATIVE_BYTES)) return false;
      const size = Number(sizeBuffer[0]);
      const output = new Uint8Array(size);
      const seekBuffer = new BigInt64Array(1);
      try {
        if (!kernel32.symbols.SetFilePointerEx(file.handle, 0n, ptr(seekBuffer), WINDOWS_FILE_BEGIN)) return false;
        const count = new Uint32Array(1);
        if (output.byteLength === 0) return new Uint8Array();
        if (!kernel32.symbols.ReadFile(file.handle, ptr(output), output.byteLength, ptr(count), null)) return false;
        return count[0] === output.byteLength ? output : false;
      } catch {
        return false;
      }
    },

    closeFile(fileToken) {
      const file = files.get(fileToken.token);
      if (file === undefined) return false;
      if (!closeNative(file.handle)) return false;
      files.delete(fileToken.token);
      const directory = directories.get(file.directory);
      if (directory !== undefined) {
        for (const value of directory.files.values()) if (value.handle === file.handle) value.handle = null;
      }
      return true;
    },

    childPath(directoryToken, name) {
      const directory = directories.get(directoryToken.token);
      return directory !== undefined && validName(name) ? `${directory.path}\\${name}` : false;
    },

    exactRegularFiles(directoryToken, expected) {
      const directory = directories.get(directoryToken.token);
      return directory !== undefined && !directory.published && exact(directory, expected);
    },

    publishNoReplace(sourceToken, destinationToken, finalName, authorizeSource) {
      const source = directories.get(sourceToken.token);
      const destination = directories.get(destinationToken.token);
      if (source === undefined || destination === undefined || source.published || !validName(finalName) || source.parentHandle === null || destination.published || typeof authorizeSource !== 'function') return false;
      const name = utf16(finalName);
      const info = new Uint8Array(20 + name.byteLength);
      const view = new DataView(info.buffer);
      view.setUint32(0, 0, true);
      view.setBigUint64(8, BigInt(destination.handle), true);
      view.setUint32(16, name.byteLength, true);
      info.set(new Uint8Array(name.buffer), 20);
      try {
        if (authorizeSource() !== true) return false;
        let ok = kernel32.symbols.SetFileInformationByHandle(source.handle, WINDOWS_FILE_RENAME_INFO_EX, ptr(info), info.byteLength);
        if (!ok) {
          // Some supported Windows builds reject a directory handle as RootDirectory
          // through the Win32 wrapper. The same retained-handle operation is exposed
          // directly by NtSetInformationFile and keeps ReplaceIfExists false.
          const statusBlock = new Uint8Array(16);
          if (authorizeSource() !== true) return false;
          ok = ntdll.symbols.NtSetInformationFile(
            source.handle,
            ptr(statusBlock),
            ptr(info),
            info.byteLength,
            10,
          ) === WINDOWS_STATUS_SUCCESS;
        }
        if (!ok) return false;
        source.published = true;
        return true;
      } catch {
        return false;
      }
    },

    disposeUnpublished(directoryToken, expectedNames) {
      const directory = directories.get(directoryToken.token);
      if (
        directory === undefined ||
        directory.published ||
        expectedNames.some((name) => !validName(name)) ||
        new Set(expectedNames).size !== expectedNames.length
      ) {
        return 'retained';
      }
      const names = enumerate(directory);
      const expectedSet = new Set(expectedNames);
      if (
        names === false ||
        names.length !== expectedNames.length ||
        !names.every((name) => expectedSet.has(name))
      ) {
        return 'retained';
      }
      const openHandles: number[] = [];
      try {
        for (const name of expectedNames) {
          const expected = directory.files.get(name);
          if (expected === undefined) return 'retained';
          const rebound = openRelative(directory, name, false, false);
          if (
            rebound === false ||
            !sameWindowsIdentity(expected.identity, rebound.identity)
          ) {
            if (rebound !== false) closeNative(rebound.handle);
            return 'retained';
          }
          openHandles.push(rebound.handle);
        }
        for (const handle of openHandles) {
          const disposition = new Uint8Array(4);
          new DataView(disposition.buffer).setUint32(0, WINDOWS_FILE_DISPOSITION_DELETE | WINDOWS_FILE_DISPOSITION_POSIX_SEMANTICS | WINDOWS_FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE, true);
          if (ntdll.symbols.NtSetInformationFile(handle, ptr(new Uint8Array(16)), ptr(disposition), disposition.byteLength, WINDOWS_FILE_DISPOSITION_INFO_EX) !== WINDOWS_STATUS_SUCCESS) return 'retained';
        }
        for (const handle of openHandles) if (!closeNative(handle)) return 'retained';
        openHandles.length = 0;
        const disposition = new Uint8Array(4);
        new DataView(disposition.buffer).setUint32(0, WINDOWS_FILE_DISPOSITION_DELETE | WINDOWS_FILE_DISPOSITION_POSIX_SEMANTICS | WINDOWS_FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE, true);
        if (ntdll.symbols.NtSetInformationFile(directory.handle, ptr(new Uint8Array(16)), ptr(disposition), disposition.byteLength, WINDOWS_FILE_DISPOSITION_INFO_EX) !== WINDOWS_STATUS_SUCCESS) return 'retained';
        return 'removed';
      } catch {
        return 'retained';
      } finally {
        for (const handle of openHandles) closeNative(handle);
      }
    },

    closeDirectory(directoryToken) {
      const directory = directories.get(directoryToken.token);
      if (directory === undefined) return false;
      for (const file of files.values()) if (file.directory === directoryToken.token) return false;
      for (const child of directories.values()) if (child.parentToken === directoryToken.token) return false;
      if (!closeNative(directory.handle)) return false;
      directories.delete(directoryToken.token);
      return true;
    },
  };
}

type LinuxIdentity = { dev: bigint; ino: bigint; mode: number; size: bigint };
type LinuxDirectoryState = {
  fd: number;
  path: string;
  parentToken: symbol | null;
  parentFd: number | null;
  parentName: string | null;
  identity: LinuxIdentity;
  files: Map<string, { identity: LinuxIdentity; fd: number | null }>;
  published: boolean;
};
type LinuxFileState = { fd: number; directory: symbol; identity: LinuxIdentity };

function loadLinuxLibrary(): NativeLibrary | false {
  try {
    return dlopen('libc.so.6', {
      open: { args: [FFIType.cstring, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
      read: { args: [FFIType.i32, FFIType.ptr, FFIType.usize], returns: FFIType.isize },
      write: { args: [FFIType.i32, FFIType.ptr, FFIType.usize], returns: FFIType.isize },
      lseek: { args: [FFIType.i32, FFIType.i64, FFIType.i32], returns: FFIType.i64 },
      fstat: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      fstatat: { args: [FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      dup: { args: [FFIType.i32], returns: FFIType.i32 },
      syscall: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.isize },
      renameat2: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32], returns: FFIType.i32 },
      unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
    }) as unknown as NativeLibrary;
  } catch {
    return false;
  }
}

function linuxStat(libc: NativeLibrary, fd: number): LinuxIdentity | false {
  const buffer = new Uint8Array(144);
  try {
    if (libc.symbols.fstat(fd, ptr(buffer)) !== 0) return false;
    const view = new DataView(buffer.buffer);
    return {
      dev: view.getBigUint64(0, true),
      ino: view.getBigUint64(8, true),
      mode: view.getUint32(24, true),
      size: view.getBigInt64(48, true),
    };
  } catch {
    return false;
  }
}

function linuxStatAt(
  libc: NativeLibrary,
  directoryFd: number,
  name: string,
): LinuxIdentity | false {
  const buffer = new Uint8Array(144);
  try {
    if (
      libc.symbols.fstatat(
        directoryFd,
        name,
        ptr(buffer),
        LINUX_AT_SYMLINK_NOFOLLOW,
      ) !== 0
    ) {
      return false;
    }
    const view = new DataView(buffer.buffer);
    return {
      dev: view.getBigUint64(0, true),
      ino: view.getBigUint64(8, true),
      mode: view.getUint32(24, true),
      size: view.getBigInt64(48, true),
    };
  } catch {
    return false;
  }
}

function sameLinuxIdentity(left: LinuxIdentity, right: LinuxIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && (left.mode & LINUX_S_IFMT) === (right.mode & LINUX_S_IFMT);
}

function createLinuxFilesystem(libc: NativeLibrary): PublicBetaNativeFilesystem {
  const directories = new Map<symbol, LinuxDirectoryState>();
  const files = new Map<symbol, LinuxFileState>();
  const directoryFlags = LINUX_O_RDONLY | LINUX_O_DIRECTORY | LINUX_O_NOFOLLOW | LINUX_O_CLOEXEC;
  const fileFlags = LINUX_O_WRONLY | LINUX_O_CREAT | LINUX_O_EXCL | LINUX_O_NOFOLLOW | LINUX_O_CLOEXEC;
  const closeFd = (fd: number): boolean => {
    try {
      return libc.symbols.close(fd) === 0;
    } catch {
      return false;
    }
  };
  const openExistingRegular = (
    directory: LinuxDirectoryState,
    name: string,
  ): { fd: number; identity: LinuxIdentity } | false => {
    let fd = -1;
    let retained = false;
    try {
      fd = libc.symbols.openat(directory.fd, name, LINUX_O_RDONLY | LINUX_O_NOFOLLOW | LINUX_O_CLOEXEC, 0);
      if (fd < 0) return false;
      const identity = linuxStat(libc, fd);
      if (identity === false || (identity.mode & LINUX_S_IFMT) !== LINUX_S_IFREG) return false;
      retained = true;
      return { fd, identity };
    } catch {
      return false;
    } finally {
      if (!retained && fd >= 0) closeFd(fd);
    }
  };
  const enumerate = (directory: LinuxDirectoryState): string[] | false => {
    let duplicate = -1;
    const buffer = new Uint8Array(64 * 1024);
    const names: string[] = [];
    try {
      duplicate = libc.symbols.dup(directory.fd);
      if (duplicate < 0) return false;
      while (true) {
        const byteCount = libc.symbols.syscall(
          LINUX_SYS_GETDENTS64,
          duplicate,
          ptr(buffer),
          buffer.byteLength,
        );
        if (byteCount < 0) return false;
        if (byteCount === 0) break;
        let offset = 0;
        while (offset < byteCount) {
          if (offset + 19 > byteCount) return false;
          const view = new DataView(buffer.buffer, offset);
          const recordLength = view.getUint16(16, true);
          const type = view.getUint8(18);
          if (recordLength < 20 || offset + recordLength > byteCount) return false;
          let name = '';
          for (let index = offset + 19; index < offset + recordLength && buffer[index] !== 0; index += 1) {
            name += String.fromCharCode(buffer[index]);
          }
          if (name !== '.' && name !== '..') {
            if (type !== LINUX_DT_REG) return false;
            names.push(name);
          }
          offset += recordLength;
        }
      }
      return names;
    } catch {
      return false;
    } finally {
      if (duplicate >= 0) closeFd(duplicate);
    }
  };
  const exact = (directory: LinuxDirectoryState, expected: readonly string[]): boolean => {
    try {
      if (expected.some((name) => !validName(name)) || new Set(expected).size !== expected.length) return false;
      const names = enumerate(directory);
      if (names === false || names.length !== expected.length) return false;
      const expectedSet = new Set(expected);
      if (!names.every((name) => expectedSet.has(name))) return false;
      for (const name of expected) {
        const retained = directory.files.get(name);
        if (retained === undefined) return false;
        const rebound = openExistingRegular(directory, name);
        if (rebound === false) return false;
        try {
          if (!sameLinuxIdentity(retained.identity, rebound.identity)) return false;
        } finally {
          closeFd(rebound.fd);
        }
      }
      return true;
    } catch {
      return false;
    }
  };
  return {
    openDirectory(path) {
      if (typeof path !== 'string' || path.length === 0) return false;
      let fd = -1;
      let retained = false;
      try {
        fd = libc.symbols.open(path, directoryFlags, 0);
        if (fd < 0) return false;
        const identity = linuxStat(libc, fd);
        if (identity === false || (identity.mode & LINUX_S_IFMT) !== LINUX_S_IFDIR) return false;
        const token = opaqueDirectory();
        directories.set(token.token, {
          fd,
          path,
          parentToken: null,
          parentFd: null,
          parentName: null,
          identity,
          files: new Map(),
          published: false,
        });
        retained = true;
        return token;
      } catch {
        return false;
      } finally {
        if (!retained && fd >= 0) closeFd(fd);
      }
    },
    createPrivateDirectory(parentToken, prefix) {
      const parent = directories.get(parentToken.token);
      if (parent === undefined || parent.published || !validPrefix(prefix)) return false;
      const name = `${prefix}${randomUUID().replaceAll('-', '')}`;
      let fd = -1;
      let retained = false;
      try {
        if (libc.symbols.mkdirat(parent.fd, name, 0o700) !== 0) return false;
        fd = libc.symbols.openat(parent.fd, name, directoryFlags, 0);
        if (fd < 0) return false;
        const identity = linuxStat(libc, fd);
        if (identity === false || (identity.mode & LINUX_S_IFMT) !== LINUX_S_IFDIR) return false;
        const token = opaqueDirectory();
        directories.set(token.token, {
          fd,
          path: `${parent.path}/${name}`,
          parentToken: parentToken.token,
          parentFd: parent.fd,
          parentName: name,
          identity,
          files: new Map(),
          published: false,
        });
        retained = true;
        return token;
      } catch {
        return false;
      } finally {
        if (!retained && fd >= 0) closeFd(fd);
      }
    },
    writeExclusiveFile(directoryToken, name, bytes) {
      const directory = directories.get(directoryToken.token);
      if (directory === undefined || directory.published || !validName(name) || !validBytes(bytes)) return false;
      let fd = -1;
      let retained = false;
      try {
        fd = libc.symbols.openat(directory.fd, name, fileFlags, 0o600);
        if (fd < 0) return false;
        const identity = linuxStat(libc, fd);
        if (identity === false || (identity.mode & LINUX_S_IFMT) !== LINUX_S_IFREG) return false;
        const written = bytes.byteLength === 0 ? 0 : libc.symbols.write(fd, ptr(bytes), bytes.byteLength);
        if ((bytes.byteLength > 0 && written !== bytes.byteLength) || (bytes.byteLength === 0 && written !== 0)) {
          return false;
        }
        const token = opaqueFile();
        files.set(token.token, { fd, directory: directoryToken.token, identity });
        directory.files.set(name, { identity, fd });
        retained = true;
        return token;
      } catch {
        return false;
      } finally {
        if (!retained && fd >= 0) closeFd(fd);
      }
    },
    retainExistingRegularFile(directoryToken, name) {
      try {
        const directory = directories.get(directoryToken.token);
        if (directory === undefined || directory.published || !validName(name)) return false;
        const existing = openExistingRegular(directory, name);
        if (existing === false) return false;
        const token = opaqueFile();
        files.set(token.token, {
          fd: existing.fd,
          directory: directoryToken.token,
          identity: existing.identity,
        });
        directory.files.set(name, { identity: existing.identity, fd: existing.fd });
        return token;
      } catch {
        return false;
      }
    },
    readFile(fileToken, maxBytes) {
      try {
        const file = files.get(fileToken.token);
        if (file === undefined || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > LINUX_MAX_NATIVE_BYTES) return false;
        const current = linuxStat(libc, file.fd);
        if (current === false || !sameLinuxIdentity(file.identity, current) || current.size < 0n || current.size > BigInt(maxBytes)) return false;
        const size = Number(current.size);
        const output = new Uint8Array(size);
        if (libc.symbols.lseek(file.fd, 0n, 0) < 0) return false;
        if (size > 0 && libc.symbols.read(file.fd, ptr(output), size) !== size) return false;
        return output;
      } catch {
        return false;
      }
    },
    closeFile(fileToken) {
      const file = files.get(fileToken.token);
      if (file === undefined || !closeFd(file.fd)) return false;
      files.delete(fileToken.token);
      const directory = directories.get(file.directory);
      if (directory !== undefined) for (const value of directory.files.values()) if (value.fd === file.fd) value.fd = null;
      return true;
    },
    childPath(directoryToken, name) {
      const directory = directories.get(directoryToken.token);
      return directory !== undefined && validName(name) ? `${directory.path}/${name}` : false;
    },
    exactRegularFiles(directoryToken, expected) {
      const directory = directories.get(directoryToken.token);
      return directory !== undefined && !directory.published && exact(directory, expected);
    },
    publishNoReplace(sourceToken, destinationToken, finalName, authorizeSource) {
      const source = directories.get(sourceToken.token);
      const destination = directories.get(destinationToken.token);
      if (source === undefined || destination === undefined || source.published || destination.published || source.parentFd === null || source.parentName === null || !validName(finalName) || typeof authorizeSource !== 'function') return false;
      try {
        if (authorizeSource() !== true) return false;
        const sourceEntryIdentity = linuxStatAt(libc, source.parentFd, source.parentName);
        if (
          sourceEntryIdentity === false ||
          (sourceEntryIdentity.mode & LINUX_S_IFMT) !== LINUX_S_IFDIR ||
          !sameLinuxIdentity(source.identity, sourceEntryIdentity)
        ) {
          return false;
        }
        const result = libc.symbols.renameat2(source.parentFd, source.parentName, destination.fd, finalName, LINUX_RENAME_NOREPLACE);
        if (result !== 0) return false;
        source.published = true;
        return true;
      } catch {
        return false;
      }
    },
    disposeUnpublished(directoryToken, expectedNames) {
      try {
        const directory = directories.get(directoryToken.token);
        if (directory === undefined || directory.published || !exact(directory, expectedNames)) return 'retained';
        // Linux exposes unlinkat by directory/name, not by the retained regular-file fd.
        // After an identity proof, a same-name replacement could still win the final
        // unlink race, so this boundary fails closed until a replacement-safe removal
        // primitive is added and reviewed on a Linux Bun runner.
        return 'retained';
      } catch {
        return 'retained';
      }
    },
    closeDirectory(directoryToken) {
      const directory = directories.get(directoryToken.token);
      if (
        directory === undefined ||
        [...files.values()].some((file) => file.directory === directoryToken.token) ||
        [...directories.values()].some((child) => child.parentToken === directoryToken.token)
      ) {
        return false;
      }
      if (!closeFd(directory.fd)) return false;
      directories.delete(directoryToken.token);
      return true;
    },
  };
}

export function createPublicBetaNativeFilesystem(): PublicBetaNativeFilesystem {
  if (process.arch !== 'x64') return unsupportedFilesystem();
  if (process.platform === 'win32') {
    const libraries = loadWindowsLibraries();
    return libraries === false ? unsupportedFilesystem() : createWindowsFilesystem(libraries);
  }
  if (process.platform === 'linux') {
    const libc = loadLinuxLibrary();
    return libc === false ? unsupportedFilesystem() : createLinuxFilesystem(libc);
  }
  return unsupportedFilesystem();
}
