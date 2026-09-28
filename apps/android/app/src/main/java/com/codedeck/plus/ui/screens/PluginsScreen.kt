package com.codedeck.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.core.CoreHost
import com.codedeck.plus.ui.components.BusyToggle
import com.codedeck.plus.ui.components.ConfirmDialog
import com.codedeck.plus.ui.components.ErrorNote
import com.codedeck.plus.ui.components.ExpandableRow
import com.codedeck.plus.ui.components.Field
import com.codedeck.plus.ui.components.Group
import com.codedeck.plus.ui.components.GroupBody
import com.codedeck.plus.ui.components.GroupScope
import com.codedeck.plus.ui.components.Note
import com.codedeck.plus.ui.components.Page
import com.codedeck.plus.ui.components.QuietButton
import com.codedeck.plus.ui.components.RowSpinner
import com.codedeck.plus.ui.components.SecondaryButton
import com.codedeck.plus.ui.components.Segmented
import com.codedeck.plus.ui.components.machineLabel
import com.codedeck.plus.ui.theme.Tokens
import kotlinx.coroutines.launch
import uniffi.client_ffi.UniffiAgentPlugins
import uniffi.client_ffi.UniffiAvailablePlugin
import uniffi.client_ffi.UniffiInstalledPlugin
import uniffi.client_ffi.UniffiIntent
import uniffi.client_ffi.UniffiMachineSummary
import uniffi.client_ffi.UniffiPluginFailure
import uniffi.client_ffi.UniffiPluginMarketplace

/** The marketplace Claude Code's own plugins come from, offered when none is known yet. */
internal const val OFFICIAL_MARKETPLACE = "anthropics/claude-plugins-official"

private enum class PluginsTab { Installed, Browse }

/** What a failed change was, in words: "install commit-commands@…". */
internal fun failureLine(f: UniffiPluginFailure): String {
    val verb = when (f.action) {
        "add-marketplace" -> "add the marketplace"
        "remove-marketplace" -> "remove the marketplace"
        "update-marketplace" -> "update the marketplace"
        else -> f.action
    }
    return "Could not $verb ${f.target}: ${f.error}"
}

/** The offer matching [query] (name or description, case aside), most
 *  installed first. */
internal fun browseResults(available: List<UniffiAvailablePlugin>, query: String): List<UniffiAvailablePlugin> {
    val q = query.trim().lowercase()
    return available
        .filter { q.isEmpty() || it.name.lowercase().contains(q) || it.description?.lowercase()?.contains(q) == true }
        .sortedWith(compareByDescending<UniffiAvailablePlugin> { it.installCount ?: 0uL }.thenBy { it.name })
}

/**
 * One agent's plugins on a machine. An agent with marketplaces (Claude Code)
 * gets two views — what is installed, with its marketplaces, and the catalog
 * to install from; one without (OpenCode) installs by package name. Pure —
 * the caller supplies the machine and a dispatcher — so it renders the same
 * in a snapshot.
 */
@Composable
fun PluginsContent(
    machine: UniffiMachineSummary,
    agentId: String,
    dispatch: (UniffiIntent) -> Unit,
    onBack: () -> Unit,
    startOnBrowse: Boolean = false,
) {
    val agent = machine.agents.firstOrNull { it.id == agentId }
    val plugins = machine.plugins.firstOrNull { it.agent == agentId }
    var tab by remember(machine.pubkeyHex, agentId) { mutableStateOf(if (startOnBrowse) PluginsTab.Browse else PluginsTab.Installed) }

    // Everything on opening, the catalog included, so Browse is ready by the
    // time it is shown; the catalog again when a marketplace comes or goes.
    LaunchedEffect(machine.pubkeyHex, agentId) {
        dispatch(UniffiIntent.RequestPlugins(machine.pubkeyHex, agentId, available = true))
    }
    val marketplaceNames = plugins?.marketplaces?.map { it.name }
    var seenMarketplaces by remember(machine.pubkeyHex, agentId) { mutableStateOf(marketplaceNames) }
    LaunchedEffect(marketplaceNames) {
        val seen = seenMarketplaces
        seenMarketplaces = marketplaceNames
        if (seen != null && marketplaceNames != null && seen != marketplaceNames) {
            dispatch(UniffiIntent.RequestPlugins(machine.pubkeyHex, agentId, available = true))
        }
    }
    fun act(action: String, target: String) = dispatch(UniffiIntent.PluginAction(machine.pubkeyHex, agentId, action, target))

    var confirm by remember { mutableStateOf<Pair<String, String>?>(null) }

    // Browse scrolls its own (lazy) list; the rest scrolls as one page.
    val browsing = tab == PluginsTab.Browse && plugins?.marketplaces != null
    Page(title = "${agent?.displayName ?: agentId} plugins", subtitle = machineLabel(machine.name), onBack = onBack, scroll = !browsing) {
        if (plugins?.marketplaces != null) {
            Segmented(
                PluginsTab.entries.map { if (it == PluginsTab.Installed) "Installed (${plugins.installed.size})" else it.name },
                selected = tab.ordinal,
                onSelect = { tab = PluginsTab.entries[it] },
            )
        }
        plugins?.failure?.let { ErrorNote(failureLine(it)) }
        when {
            plugins == null -> Note("Asking the machine…")
            plugins.error != null && plugins.installed.isEmpty() && plugins.marketplaces.isNullOrEmpty() -> ErrorNote(plugins.error!!)
            tab == PluginsTab.Browse -> BrowseView(plugins, ::act)
            else -> InstalledView(plugins, ::act, onBrowse = { tab = PluginsTab.Browse }, onConfirm = { confirm = it })
        }
    }

    confirm?.let { (action, target) ->
        val removing = action == "uninstall"
        ConfirmDialog(
            title = if (removing) "Uninstall $target?" else "Remove the marketplace $target?",
            body = if (removing) "Sessions on this machine stop loading it." else "Plugins installed from it stay until you uninstall them.",
            confirm = if (removing) "Uninstall" else "Remove",
            onConfirm = { act(action, target) },
            onDismiss = { confirm = null },
        )
    }
}

@Composable
private fun InstalledView(
    plugins: UniffiAgentPlugins,
    act: (String, String) -> Unit,
    onBrowse: () -> Unit,
    onConfirm: (Pair<String, String>) -> Unit,
) {
    val marketplaces = plugins.marketplaces
    if (plugins.installed.isEmpty()) {
        Group {
            GroupBody {
                Text("No plugins installed", color = Tokens.Text, fontSize = Tokens.TextLg)
                Text(
                    if (marketplaces != null) "Plugins add commands, skills, agents and hooks to every session on this machine."
                    else "Plugins are npm packages that extend every session on this machine.",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextSm,
                )
                if (!marketplaces.isNullOrEmpty()) SecondaryButton("Browse plugins", onBrowse)
            }
        }
    } else {
        // Without marketplaces there are no tabs to say what this list is.
        Group(title = if (marketplaces == null) "Installed" else null) {
            plugins.installed.forEachIndexed { i, p ->
                if (i > 0) Divider()
                InstalledRow(p, busy = p.id in plugins.busy, toggles = plugins.toggles, act = act, onUninstall = { onConfirm("uninstall" to p.id) })
            }
        }
    }
    if (marketplaces == null) {
        PackageInstall(plugins, act)
    } else {
        Marketplaces(marketplaces, plugins.busy, act, onRemove = { onConfirm("remove-marketplace" to it) })
    }
}

@Composable
private fun InstalledRow(p: UniffiInstalledPlugin, busy: Boolean, toggles: Boolean, act: (String, String) -> Unit, onUninstall: () -> Unit) {
    var open by remember(p.id) { mutableStateOf(false) }
    ExpandableRow(
        p.name,
        p.description,
        enabled = p.enabled,
        open = open,
        onOpenChange = { open = it },
        trailing = { BusyToggle(p.enabled, busy, toggles) { on -> act(if (on) "enable" else "disable", p.id) } },
    ) {
        val origin = listOfNotNull(p.marketplace?.let { "From $it" }, p.version?.let { "version ${it.take(12)}" })
        if (origin.isNotEmpty()) Text(origin.joinToString(", "), color = Tokens.TextDim, fontSize = Tokens.TextXs, modifier = Modifier.padding(top = 4.dp))
        Row(Modifier.padding(top = 2.dp)) { QuietButton("Uninstall", onClick = onUninstall, danger = true, enabled = !busy) }
    }
}

@Composable
private fun Marketplaces(marketplaces: List<UniffiPluginMarketplace>, busy: List<String>, act: (String, String) -> Unit, onRemove: (String) -> Unit) {
    var source by remember { mutableStateOf("") }
    Group(
        title = "Marketplaces",
        footer = "A marketplace is a git repository listing plugins — yours too. Add one by owner/repo or its URL.",
    ) {
        marketplaces.forEachIndexed { i, m ->
            if (i > 0) Divider()
            MarketplaceRow(m, busy = m.name in busy, onUpdate = { act("update-marketplace", m.name) }, onRemove = { onRemove(m.name) })
        }
        if (marketplaces.isNotEmpty()) Divider()
        GroupBody {
            if (marketplaces.isEmpty()) {
                Text("No marketplace yet. Claude Code's own is the usual start.", color = Tokens.TextMuted, fontSize = Tokens.TextSm)
                SecondaryButton(
                    if (OFFICIAL_MARKETPLACE in busy) "Adding…" else "Add the official marketplace",
                    onClick = { act("add-marketplace", OFFICIAL_MARKETPLACE) },
                    enabled = OFFICIAL_MARKETPLACE !in busy,
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Field(source, { source = it }, Modifier.weight(1f), placeholder = "owner/repo or URL", mono = true)
                val adding = source.trim() in busy
                SecondaryButton(if (adding) "Adding…" else "Add", onClick = {
                    act("add-marketplace", source.trim())
                    source = ""
                }, enabled = source.isNotBlank() && !adding)
            }
        }
    }
}

/** A marketplace: its name and where it comes from; a tap offers updating
 *  or removing it. */
@Composable
private fun MarketplaceRow(m: UniffiPluginMarketplace, busy: Boolean, onUpdate: () -> Unit, onRemove: () -> Unit) {
    var open by remember(m.name) { mutableStateOf(false) }
    ExpandableRow(
        m.name,
        m.source,
        enabled = true,
        open = open,
        onOpenChange = { open = it },
        openSubtitleLines = 3,
        trailing = { if (busy) RowSpinner() },
    ) {
        Row(Modifier.padding(top = 2.dp)) {
            QuietButton("Update", onClick = onUpdate, enabled = !busy)
            QuietButton("Remove", onClick = onRemove, danger = true, enabled = !busy)
        }
    }
}

@Composable
private fun PackageInstall(plugins: UniffiAgentPlugins, act: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    Group(
        title = "Install a plugin",
        footer = "It is installed from npm the next time OpenCode loads. Changing its plugins reloads OpenCode, which restarts its running sessions.",
    ) {
        GroupBody {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Field(name, { name = it }, Modifier.weight(1f), placeholder = "npm package name", mono = true)
                val installing = name.trim() in plugins.busy
                SecondaryButton(if (installing) "Installing…" else "Install", onClick = {
                    act("install", name.trim())
                    name = ""
                }, enabled = name.isNotBlank() && !installing)
            }
        }
    }
}

/** The catalog, as a lazy list: only the rows on screen are composed, so a
 *  marketplace of hundreds opens at once. */
@Composable
private fun ColumnScope.BrowseView(plugins: UniffiAgentPlugins, act: (String, String) -> Unit) {
    var query by remember { mutableStateOf("") }
    val available = plugins.available
    if (plugins.marketplaces.isNullOrEmpty()) {
        Note("Add a marketplace to browse its plugins.")
        return
    }
    if (available == null) {
        Note("Reading the marketplaces…")
        return
    }
    Field(query, { query = it }, placeholder = "Search ${available.size} plugins")
    val results = remember(available, query) { browseResults(available, query) }
    if (results.isEmpty()) {
        Note(if (available.isEmpty()) "Everything these marketplaces offer is installed." else "No plugin matches “${query.trim()}”.")
        return
    }
    val shape = RoundedCornerShape(Tokens.RadiusXl)
    LazyColumn(
        Modifier
            .weight(1f)
            .fillMaxWidth()
            .clip(shape)
            .background(Tokens.SurfaceRaised)
            .border(1.dp, Tokens.Border, shape),
    ) {
        itemsIndexed(results, key = { _, p -> p.id }) { i, p ->
            if (i > 0) HorizontalDivider(Modifier.padding(start = Tokens.Space4), thickness = 1.dp, color = Tokens.Border)
            AvailableRow(p, busy = p.id in plugins.busy) { act("install", p.id) }
        }
    }
}

@Composable
private fun AvailableRow(p: UniffiAvailablePlugin, busy: Boolean, onInstall: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = Tokens.Space4, end = Tokens.Space3, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(p.name, color = Tokens.Text, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            p.description?.let { Text(it, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            val installs = p.installCount?.let { "%,d installs".format(it.toLong()) }
            Text(listOfNotNull(p.marketplace, installs).joinToString(", "), color = Tokens.TextDim, fontSize = Tokens.TextXs, maxLines = 1)
        }
        SecondaryButton(if (busy) "Installing…" else "Install", onClick = onInstall, enabled = !busy)
    }
}

/** [PluginsContent] for [agentId] on the machine [pubkey], from the core; closes when the machine goes away. */
@Composable
fun PluginsScreen(core: CoreHost, pubkey: String, agentId: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    val machine = machineOrLeave(core, pubkey, onGone = onBack) ?: return
    PluginsContent(machine, agentId, dispatch = { intent -> scope.launch { core.dispatch(intent) } }, onBack = onBack)
}
