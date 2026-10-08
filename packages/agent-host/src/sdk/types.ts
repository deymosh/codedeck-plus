/**
 * The driver-protocol types the host programs against, named from the
 * host's side of the pipe. `generated/protocol.ts` (built from
 * crates/agent-protocol) has two shapes per type: `_Serialize` is what the
 * bridge writes, `_Deserialize` what the bridge accepts. The host reads the
 * first and writes the second.
 */
import type * as G from '../generated/protocol';

// What the host receives.
export type BridgeFrame = G.Frame_Serialize<G.BridgeMessage_Serialize>;
export type BridgeMessage = G.BridgeMessage_Serialize;
export type StartSession = G.StartSession_Serialize;
export type ProviderBinding = G.ProviderBinding_Serialize;
export type SelectOutcome = G.SelectOutcome;
export type PlanOutcome = G.PlanOutcome_Serialize;
export type QuestionOutcome = G.QuestionOutcome;
export type SessionOption = G.SessionOption;
export type McpAction = G.McpAction;
export type McpServerAdd = G.McpServerAdd;
export type McpServerSetup = G.McpServerSetup;

// What the host sends.
export type HostFrame = G.Frame_Deserialize<G.HostMessage_Deserialize>;
export type HostMessage = G.HostMessage_Deserialize;
export type AgentInfo = G.AgentInfo_Deserialize;
export type SessionEvent = G.SessionEvent_Deserialize;
export type OutputEntry = G.OutputEntry_Deserialize;
export type DiffLine = G.DiffLine;
export type Subagent = G.Subagent_Deserialize;
export type ToolKind = G.ToolKind;
export type TaskKind = G.TaskKind;
export type TaskStatus = G.TaskStatus;
export type TodoItem = G.TodoItem_Deserialize;
export type PermissionOption = G.PermissionOption;
export type OptionChoice = G.OptionChoice_Deserialize;
export type QuestionSpec = G.QuestionSpec_Deserialize;
export type ModelEntry = G.ModelEntry_Deserialize;
export type SlashCommand = G.SlashCommand_Deserialize;
export type InstalledPlugin = G.InstalledPlugin_Deserialize;
export type AvailablePlugin = G.AvailablePlugin_Deserialize;
export type PluginMarketplace = G.PluginMarketplace;
export type PluginAction = G.PluginAction;
export type McpServerInfo = G.McpServerInfo_Deserialize;
export type SessionMcpServer = G.SessionMcpServer_Deserialize;
export type McpStatus = G.McpStatus;
export type UsageData = G.UsageData_Deserialize;
export type UsageWindow = G.UsageWindow;
export type PermissionRequest = G.PermissionRequest_Deserialize;

/** Version of the driver protocol this host speaks (the frame `v`). */
export const DRIVER_PROTOCOL_VERSION = 1;
