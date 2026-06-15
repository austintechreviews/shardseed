import { open } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface FileInspection {
  file_format: string;
  gguf_version: number | null;
  architecture: string | null;
  parameter_count: number | null;
  tensor_count: number | null;
  quantisation: string | null;
  context_length: number | null;
  tokenizer: string | null;
  declared_model_name: string | null;
}

export async function inspectFile(path: string): Promise<FileInspection> {
  if (extname(path).toLowerCase() !== ".gguf") {
    return generic(path);
  }
  const fd = await open(path, "r");
  try {
    const header = Buffer.alloc(24);
    const { bytesRead } = await fd.read(header, 0, header.length, 0);
    if (bytesRead < 24 || header.subarray(0, 4).toString("ascii") !== "GGUF") return generic(path);
    const version = header.readUInt32LE(4);
    const tensorCount = Number(header.readBigUInt64LE(8));
    const kvCount = Number(header.readBigUInt64LE(16));
    if (!Number.isSafeInteger(tensorCount) || !Number.isSafeInteger(kvCount) || kvCount > 100000) {
      return { ...generic(path), file_format: "gguf", gguf_version: version };
    }
    return {
      file_format: "gguf",
      gguf_version: version,
      architecture: null,
      parameter_count: null,
      tensor_count: tensorCount,
      quantisation: inferQuantisation(path),
      context_length: null,
      tokenizer: null,
      declared_model_name: basename(path, ".gguf")
    };
  } finally {
    await fd.close();
  }
}

function inferQuantisation(path: string): string | null {
  const match = basename(path).match(/(?:^|[-_.])(Q\d+_[A-Z]_[A-Z]|Q\d+_[A-Z]+|F\d+|BF\d+)(?:[-_.]|$)/i);
  return match ? match[1].toUpperCase() : null;
}

function generic(path: string): FileInspection {
  return {
    file_format: extname(path).replace(".", "") || "unknown",
    gguf_version: null,
    architecture: null,
    parameter_count: null,
    tensor_count: null,
    quantisation: inferQuantisation(path),
    context_length: null,
    tokenizer: null,
    declared_model_name: basename(path)
  };
}
