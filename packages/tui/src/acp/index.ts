/** The ACP front-end: `minima acp` and everything behind the socket. */

export { type AcpFrontEnd, type AcpFrontEndOptions, acpFrontEnd } from "./frontend.ts";
export {
  ALLOW_ALWAYS,
  ALLOW_ONCE,
  AcpPermissionBridge,
  REJECT_ONCE,
  decisionForOutcome,
  permissionOptions,
  permissionRequest,
} from "./permission.ts";
export {
  AgentEventSerializer,
  type SerializerOptions,
  type SessionUpdateSink,
  titleFor,
  toolCallLocations,
  toolKindFor,
} from "./serializer.ts";
export { type AcpServerDeps, agentCapabilities, promptText, serveAcp } from "./server.ts";
export { stdioStream } from "./stdio.ts";
