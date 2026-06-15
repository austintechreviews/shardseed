export const RELEASE_SCHEMA = "org.shardseed.release/v1";
export const PAYLOAD_TYPE = "application/vnd.shardseed.release.v1+json";

export type SerializationRisk = "data-only" | "unknown" | "requires-code";

export interface ReleaseStatement {
  schema: typeof RELEASE_SCHEMA;
  release: {
    name: string;
    version: string;
    created_at: string;
    description: string;
  };
  model: {
    publisher_namespace: string;
    model_slug: string;
    architecture: string;
    parameter_count: number | null;
    formats: string[];
  };
  artifacts: Artifact[];
  transport: {
    bittorrent: {
      magnet_uri: string;
      infohash_v1: string | null;
      infohash_v2: string | null;
      torrent_file_sha256: string;
      trackers: string[];
      web_seeds: string[];
    };
  };
  lineage: { parents: string[] };
  licensing: {
    weights: {
      expression: string;
      text_path: string | null;
      source_url: string | null;
      redistribution_claimed: boolean;
    };
  };
  security: {
    contains_executable_code: boolean;
    requires_custom_code: boolean;
    serialization_risk: SerializationRisk;
  };
  publisher: {
    display_name: string;
    key_id: string;
  };
}

export interface Artifact {
  path: string;
  role: "weights" | "tokenizer" | "metadata" | "license" | "documentation" | "config";
  media_type: string;
  size: number;
  digests: { sha256: string };
  format: {
    family: string;
    version: number | null;
    quantisation: string | null;
  };
}

export interface SignedEnvelope {
  payload_type: typeof PAYLOAD_TYPE;
  payload: string;
  signatures: Array<{
    key_id: string;
    signature: string;
  }>;
}
