import { fail } from "../errors.js";
import { canonicalJson } from "./canonical.js";
import { parseJsonStrict } from "./json.js";
import { PAYLOAD_TYPE, ReleaseStatement, SignedEnvelope } from "./types.js";
import { validateEnvelope, validateStatement } from "./validate.js";
import { assertKeyMatchesId, signBytes, verifyBytes } from "../crypto/keys.js";

export function signStatement(statement: ReleaseStatement, privatePem: string, publicPem: string): SignedEnvelope {
  validateStatement(statement);
  assertKeyMatchesId(publicPem, statement.publisher.key_id);
  const payload = canonicalJson(statement);
  return {
    payload_type: PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ key_id: statement.publisher.key_id, signature: signBytes(payload, privatePem) }]
  };
}

export function parseEnvelope(envelope: SignedEnvelope): ReleaseStatement {
  validateEnvelope(envelope);
  const bytes = Buffer.from(envelope.payload, "base64");
  const statement = parseJsonStrict(bytes.toString("utf8"), "manifest.payload") as ReleaseStatement;
  validateStatement(statement);
  return statement;
}

export function parseEnvelopeJson(text: string): SignedEnvelope {
  const envelope = parseJsonStrict(text, "manifest.envelope") as SignedEnvelope;
  validateEnvelope(envelope);
  return envelope;
}

export function verifyEnvelope(envelope: SignedEnvelope, publicPem: string): ReleaseStatement {
  validateEnvelope(envelope);
  const statement = parseEnvelope(envelope);
  const sig = envelope.signatures.find((s) => s.key_id === statement.publisher.key_id);
  if (!sig) fail("manifest.signature_missing", "Manifest signature does not include publisher key");
  assertKeyMatchesId(publicPem, statement.publisher.key_id);
  const payload = Buffer.from(envelope.payload, "base64");
  if (!verifyBytes(payload, sig.signature, publicPem)) fail("manifest.signature_invalid", "Manifest signature is invalid");
  return statement;
}
