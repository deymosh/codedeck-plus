package com.codedeck.plus.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiSessionCommands
import uniffi.client_ffi.UniffiSlashCommand

/** What follows the slash while the draft is still a bare `/name` being
 *  typed — null once it holds anything else (arguments, a second line, text
 *  that only starts with a slash further in). */
internal fun slashQuery(draft: String): String? {
    if (!draft.startsWith("/")) return null
    val query = draft.substring(1)
    return query.takeIf { it.none(Char::isWhitespace) && !it.contains('/') }
}

/** The commands matching a query, case aside: names that start with it
 *  first, then names that contain it (a plugin's `plugin:command` is found by
 *  its command part too), each group in the agent's own order. */
internal fun matchingCommands(commands: List<UniffiSlashCommand>, query: String): List<UniffiSlashCommand> {
    val q = query.lowercase()
    val (starts, rest) = commands.partition { it.name.lowercase().startsWith(q) }
    return starts + rest.filter { it.name.lowercase().contains(q) }
}

/**
 * The slash-command menu over the composer: the session's commands matching
 * what follows the `/`, a tap picks one. Until the bridge has answered it
 * says so; an answer with no commands shows the reason it came with.
 */
@Composable
internal fun SlashCommandMenu(
    commands: UniffiSessionCommands?,
    query: String,
    onPick: (UniffiSlashCommand) -> Unit,
) {
    val shape = RoundedCornerShape(Tokens.RadiusLg)
    val matches = commands?.commands?.let { matchingCommands(it, query) }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space1)
            .clip(shape)
            .background(Tokens.SurfaceRaised)
            .border(1.dp, Tokens.Border, shape),
    ) {
        val note = when {
            commands == null -> "Loading commands…"
            commands.commands.isEmpty() -> commands.error ?: "This session has no commands."
            matches.isNullOrEmpty() -> "No command starts with /$query"
            else -> null
        }
        if (note != null) {
            Text(note, color = Tokens.TextMuted, fontSize = Tokens.TextSm, modifier = Modifier.padding(Tokens.Space4))
            return@Column
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 280.dp)) {
            items(matches.orEmpty(), key = { it.name }) { command -> CommandRow(command, query, onPick) }
        }
    }
}

/** `/name` with the part the query matched in full strength and the rest
 *  receding, so each row shows why it is listed. */
internal fun highlightedName(name: String, query: String): AnnotatedString = buildAnnotatedString {
    val at = if (query.isEmpty()) -1 else name.lowercase().indexOf(query.lowercase())
    // Lowercasing can change a string's length (e.g. "I" -> Turkish dotless
    // i on some locales), so the match on the lowercased name may extend
    // past the original name's end. The match length in the ORIGINAL string
    // is what bounds the highlight; fall back to no highlight when the
    // bounds are unsound.
    val end = (at + query.length).coerceAtMost(name.length)
    val match = at >= 0 && at < end
    val muted = SpanStyle(color = Tokens.TextMuted)
    withStyle(muted) { append("/") }
    if (!match) {
        withStyle(SpanStyle(color = Tokens.Text)) { append(name) }
        return@buildAnnotatedString
    }
    withStyle(muted) { append(name.substring(0, at)) }
    withStyle(SpanStyle(color = Tokens.Text, fontWeight = FontWeight.SemiBold)) { append(name.substring(at, end)) }
    withStyle(muted) { append(name.substring(end)) }
}

@Composable
private fun CommandRow(command: UniffiSlashCommand, query: String, onPick: (UniffiSlashCommand) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable { onPick(command) }
            .padding(horizontal = Tokens.Space4, vertical = Tokens.Space2),
    ) {
        // The name is what is picked, so it is measured first; the hint gets
        // what is left of the line.
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                highlightedName(command.name, query),
                fontFamily = Tokens.FontMono,
                fontSize = Tokens.TextMd,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            command.argumentHint?.let { hint ->
                Text(
                    hint,
                    color = Tokens.TextDim,
                    fontSize = Tokens.TextSm,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f).padding(start = Tokens.Space2),
                )
            }
        }
        command.description?.let { description ->
            Text(description, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
