package com.codedeck.plus.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.BusyToggle
import com.codedeck.plus.ui.components.Chip
import com.codedeck.plus.ui.components.ConfirmDialog
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.ExpandableRow
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.Note
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.PrimaryButton
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.Segmented
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAgentMcp
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiMcpFailure
import uniffi.client_ffi.UniffiMcpImport
import uniffi.client_ffi.UniffiMcpServer
import uniffi.client_ffi.UniffiMcpServerSpec
import uniffi.client_ffi.mcpImport
import uniffi.client_ffi.mcpServerProblem

/** What a failed change was, in words: "Could not add github: …". */
internal fun mcpFailureLine(f: UniffiMcpFailure): String {
    val verb = when (f.action) {
        "add" -> "add"
        "remove" -> "remove"
        "enable" -> "turn on"
        else -> "turn off"
    }
    return "Could not $verb ${f.names.joinToString(", ")}: ${f.error}"
}

/** How a server is reached, in words. */
internal fun transportLabel(transport: String): String = when (transport) {
    "stdio" -> "Command"
    "sse" -> "SSE"
    else -> "HTTP"
}

/**
 * One agent's MCP servers on a machine: the list, and adding one by filling
 * in its settings or by pasting the JSON a server documents for other
 * clients. Secrets typed or pasted here go to the machine and never come
 * back: a server shows its program or URL and the names of what is set.
 * Pure — the caller supplies the machine and a dispatcher — so it renders
 * the same in a snapshot.
 */
@Composable
fun McpContent(
    machine: UniffiMachineSummary,
    agentId: String,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    /** Opens straight on the Add view (for a snapshot). */
    startAdding: AddView? = null,
    /** What the paste box starts with (for a snapshot). */
    pasted: String = "",
    /** The core's import parser and server check — native calls, so a
     *  snapshot, which cannot load the core, passes its own. */
    parse: (String) -> UniffiMcpImport = ::mcpImport,
    check: (UniffiMcpServerSpec) -> String? = ::mcpServerProblem,
) {
    val agent = machine.agents.firstOrNull { it.id == agentId }
    val mcp = machine.mcp.firstOrNull { it.agent == agentId }
    var adding by remember(machine.pubkeyHex, agentId) { mutableStateOf(startAdding) }
    LaunchedEffect(machine.pubkeyHex, agentId) { dispatch(UniffiIntent.RequestMcp(machine.pubkeyHex, agentId)) }
    fun act(action: String, servers: List<UniffiMcpServerSpec> = emptyList(), names: List<String> = emptyList()) =
        dispatch(UniffiIntent.McpAction(machine.pubkeyHex, agentId, action, servers, names))

    val agentName = agent?.displayName ?: agentId
    val start = adding
    if (start != null) {
        AddServer(agentName, machine, start, pasted, parse, check, onAdd = { servers ->
            act("add", servers = servers)
            adding = null
        }, onBack = { adding = null })
        return
    }

    var confirmRemove by remember { mutableStateOf<String?>(null) }
    Page(
        title = "$agentName MCP servers",
        subtitle = machineLabel(machine.name),
        onBack = onBack,
        bottomBar = { PrimaryButton("Add a server", onClick = { adding = AddView.Form }, modifier = Modifier.fillMaxWidth()) },
    ) {
        mcp?.failure?.let { ErrorNote(mcpFailureLine(it)) }
        when {
            mcp == null -> Note("Asking the machine…")
            mcp.error != null && mcp.servers.isEmpty() -> ErrorNote(mcp.error!!)
            mcp.servers.isEmpty() -> Group {
                GroupBody {
                    Text("No MCP servers yet", color = Tokens.Text, fontSize = Tokens.TextLg)
                    Text(
                        "An MCP server gives $agentName's sessions more tools: GitHub, a database, a browser, your issue tracker. " +
                            "Add one with its settings, or paste the JSON its instructions give for another client.",
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                    )
                    QuietButton("Paste JSON", onClick = { adding = AddView.Json })
                }
            }
            else -> ServerList(mcp, act = { action, name -> act(action, names = listOf(name)) }, onRemove = { confirmRemove = it })
        }
        if (mcp != null && mcp.servers.isNotEmpty()) {
            Text(
                "Every session of $agentName on this machine loads these, and so does $agentName run in a terminal there." +
                    if (mcp.toggles) "" else " To pause one, switch it off inside a session.",
                color = Tokens.TextDim,
                fontSize = Tokens.TextXs,
                modifier = Modifier.padding(horizontal = Tokens.Space2),
            )
        }
    }

    confirmRemove?.let { name ->
        ConfirmDialog(
            title = "Remove $name?",
            body = "Its settings, and any token in them, are deleted from the machine.",
            confirm = "Remove",
            onConfirm = { act("remove", names = listOf(name)) },
            onDismiss = { confirmRemove = null },
        )
    }
}

/** The Add view's two ways in: the form for one server, or pasted JSON. */
enum class AddView { Form, Json }

@Composable
private fun ServerList(mcp: UniffiAgentMcp, act: (String, String) -> Unit, onRemove: (String) -> Unit) {
    Group {
        mcp.servers.forEachIndexed { i, s ->
            if (i > 0) GroupScope.Divider()
            ServerRow(s, busy = s.name in mcp.busy, toggles = mcp.toggles, act = act, onRemove = { onRemove(s.name) })
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ServerRow(s: UniffiMcpServer, busy: Boolean, toggles: Boolean, act: (String, String) -> Unit, onRemove: () -> Unit) {
    var open by remember(s.name) { mutableStateOf(false) }
    ExpandableRow(
        s.name,
        s.target,
        enabled = s.enabled,
        open = open,
        onOpenChange = { open = it },
        subtitleMono = true,
        openSubtitleLines = 3,
        trailing = { BusyToggle(s.enabled, busy, toggles) { on -> act(if (on) "enable" else "disable", s.name) } },
    ) {
        FlowRow(Modifier.padding(top = Tokens.Space2), horizontalArrangement = Arrangement.spacedBy(Tokens.Space1), verticalArrangement = Arrangement.spacedBy(Tokens.Space1)) {
            Chip(transportLabel(s.transport))
            s.headerKeys.forEach { Chip("Header $it") }
            s.envKeys.forEach { Chip(it) }
        }
        Row(Modifier.padding(top = 2.dp)) { QuietButton("Remove", onClick = onRemove, danger = true, enabled = !busy) }
    }
}

/** A key and its (secret) value, as the form edits them. */
private class SecretPair(key: String = "", value: String = "") {
    var key by mutableStateOf(key)
    var value by mutableStateOf(value)
}

/**
 * Adding servers: the form for one, or pasted JSON for several at once.
 * Both check a server with the rules the machine applies before anything
 * is sent.
 */
@Composable
private fun AddServer(
    agentName: String,
    machine: UniffiMachineSummary,
    start: AddView,
    pasted: String,
    parse: (String) -> UniffiMcpImport,
    check: (UniffiMcpServerSpec) -> String?,
    onAdd: (List<UniffiMcpServerSpec>) -> Unit, onBack: () -> Unit) {
    var mode by remember { mutableStateOf(if (start == AddView.Json) AddView.Json else AddView.Form) }
    // The form.
    var name by remember { mutableStateOf("") }
    var transport by remember { mutableStateOf("http") }
    var command by remember { mutableStateOf("") }
    var args by remember { mutableStateOf("") }
    var url by remember { mutableStateOf("") }
    var bearer by remember { mutableStateOf("") }
    val env = remember { mutableStateListOf<SecretPair>() }
    val headers = remember { mutableStateListOf<SecretPair>() }
    // The paste.
    var json by remember { mutableStateOf(pasted) }
    val parsed: UniffiMcpImport? = remember(json) { json.takeIf { it.isNotBlank() }?.let(parse) }

    fun formSpec(): UniffiMcpServerSpec {
        val headerMap = headers.filter { it.key.isNotBlank() }.associate { it.key.trim() to it.value }.toMutableMap()
        if (bearer.isNotBlank()) headerMap["Authorization"] = "Bearer ${bearer.trim()}"
        return UniffiMcpServerSpec(
            name = name.trim(),
            transport = transport,
            command = command.trim(),
            args = args.lines().map { it.trim() }.filter { it.isNotEmpty() },
            env = env.filter { it.key.isNotBlank() }.associate { it.key.trim() to it.value },
            url = url.trim(),
            headers = headerMap,
        )
    }
    val formProblem = if (mode == AddView.Form && name.isNotBlank()) check(formSpec()) else null
    val canAdd = when (mode) {
        AddView.Form -> name.isNotBlank() && formProblem == null
        AddView.Json -> parsed != null && parsed.servers.isNotEmpty()
    }
    val addLabel = when {
        mode == AddView.Json && (parsed?.servers?.size ?: 0) > 1 -> "Add ${parsed!!.servers.size} servers"
        else -> "Add server"
    }

    Page(
        title = "Add an MCP server",
        subtitle = "$agentName on ${machineLabel(machine.name)}",
        onBack = onBack,
        backLabel = "Cancel",
        bottomBar = {
            PrimaryButton(addLabel, onClick = {
                onAdd(if (mode == AddView.Form) listOf(formSpec()) else parsed!!.servers)
            }, enabled = canAdd, modifier = Modifier.fillMaxWidth())
        },
    ) {
        Segmented(listOf("Fill in", "Paste JSON"), selected = mode.ordinal, onSelect = { mode = AddView.entries[it] }, track = Tokens.SurfaceInput)
        if (mode == AddView.Form) {
            Group {
                GroupBody {
                    Field(name, { name = it }, label = "Name", placeholder = "github", mono = true)
                    Segmented(
                        listOf("HTTP", "SSE", "Command"),
                        selected = listOf("http", "sse", "stdio").indexOf(transport),
                        onSelect = { transport = listOf("http", "sse", "stdio")[it] },
                        track = Tokens.SurfaceInput,
                    )
                    if (transport == "stdio") {
                        Field(command, { command = it }, label = "Command", placeholder = "npx", mono = true)
                        Field(args, { args = it }, label = "Arguments, one per line", placeholder = "-y\n@modelcontextprotocol/server-filesystem", mono = true, singleLine = false)
                    } else {
                        Field(url, { url = it }, label = "URL", placeholder = "https://mcp.example.com/mcp", mono = true)
                        Field(
                            bearer,
                            { bearer = it },
                            label = "Bearer token",
                            supporting = "Sent as the Authorization header. Leave empty if the server needs none.",
                            mono = true,
                            visualTransformation = PasswordVisualTransformation(),
                        )
                    }
                }
            }
            if (transport == "stdio") {
                SecretPairs("Environment variables", "API_KEY", env)
            } else {
                SecretPairs("Other headers", "X-Api-Key", headers)
            }
            formProblem?.let { ErrorNote(it) }
        } else {
            Field(
                json,
                { json = it },
                placeholder = "{\n  \"mcpServers\": {\n    \"github\": {\n      \"type\": \"http\",\n      \"url\": \"https://…\"\n    }\n  }\n}",
                mono = true,
                singleLine = false,
                modifier = Modifier.heightIn(min = 180.dp),
            )
            Text(
                "Paste the JSON a server's instructions give for Claude Code, Claude Desktop, Cursor, VS Code or OpenCode. " +
                    "Several servers at once work too.",
                color = Tokens.TextDim,
                fontSize = Tokens.TextXs,
                modifier = Modifier.padding(horizontal = Tokens.Space2),
            )
            parsed?.let { ImportPreview(it) }
        }
    }
}

@Composable
private fun ImportPreview(found: UniffiMcpImport) {
    found.error?.let {
        ErrorNote(it)
        return
    }
    if (found.servers.isNotEmpty()) {
        Group(title = if (found.servers.size == 1) "Ready to add" else "Ready to add, ${found.servers.size} servers") {
            found.servers.forEachIndexed { i, s ->
                if (i > 0) GroupScope.Divider()
                val setKeys = (s.headers.keys + s.env.keys).sorted()
                Column(Modifier.fillMaxWidth().padding(horizontal = Tokens.Space4, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(s.name, color = Tokens.Text, fontSize = Tokens.TextLg)
                    Text(
                        if (s.transport == "stdio") (listOf(s.command) + s.args).joinToString(" ") else s.url,
                        color = Tokens.TextMuted,
                        fontSize = Tokens.TextSm,
                        fontFamily = Tokens.FontMono,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (setKeys.isNotEmpty()) Text("Sets ${setKeys.joinToString(", ")}", color = Tokens.TextDim, fontSize = Tokens.TextXs)
                }
            }
        }
    }
    if (found.problems.isNotEmpty()) {
        Group(title = "Left out") {
            GroupBody { found.problems.forEach { Text(it.reason, color = Tokens.Danger, fontSize = Tokens.TextSm) } }
        }
    }
}

/** Keys with masked values; a row is added on demand. */
@Composable
private fun SecretPairs(title: String, keyHint: String, pairs: MutableList<SecretPair>) {
    Group(title = title) {
        GroupBody {
            pairs.forEachIndexed { i, p ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    Field(p.key, { p.key = it }, Modifier.weight(1f), placeholder = keyHint, mono = true)
                    Field(p.value, { p.value = it }, Modifier.weight(1.3f), placeholder = "value", mono = true, visualTransformation = PasswordVisualTransformation())
                    QuietButton("Remove", onClick = { pairs.removeAt(i) })
                }
            }
            QuietButton(if (pairs.isEmpty()) "Add one" else "Add another", onClick = { pairs.add(SecretPair()) })
        }
    }
}

/** [McpContent] for [agentId] on the machine [pubkey], from the core; closes when the machine goes away. */
@Composable
fun McpScreen(core: CoreHost, pubkey: String, agentId: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    McpContent(machine, agentId, dispatch = { intent -> scope.launch { core.dispatch(intent) } }, onBack = onBack)
}
