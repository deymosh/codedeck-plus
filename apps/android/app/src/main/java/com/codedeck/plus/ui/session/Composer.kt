package com.codedeck.plus.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiQuickPrompt

/**
 * The message input, one rounded surface: the text on top, and under it one
 * row of controls — `+` (a photo or any file), [options] (what the next
 * turn runs with), then on the right one round button for the rest: Send
 * once something is typed; while a turn runs and nothing is, Stop;
 * otherwise dictation. A long press on it dictates whatever it shows, so
 * the microphone takes no room of its own. Every control but the text
 * takes the focus off it first: the keyboard goes, and a sheet it opens
 * does not bring it back on closing.
 */
@Composable
internal fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    canAttach: Boolean,
    uploading: Boolean,
    canSend: Boolean,
    /** Stops the running turn; `null` when none runs. */
    onStop: (() -> Unit)?,
    onAttachPhoto: () -> Unit,
    onAttachFile: () -> Unit,
    onDictate: () -> Unit,
    onSend: () -> Unit,
    focusRequester: FocusRequester = FocusRequester(),
    options: (@Composable () -> Unit)? = null,
) {
    val focus = LocalFocusManager.current
    val shape = RoundedCornerShape(26.dp)
    // The field keeps its own cursor; a draft replaced from outside (a quick
    // prompt, a picked command, a sent message) puts it at the end, so what
    // is typed next follows the new text.
    var field by remember { mutableStateOf(TextFieldValue(draft, TextRange(draft.length))) }
    val shown = if (field.text == draft) field else TextFieldValue(draft, TextRange(draft.length))
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2)
            .clip(shape)
            .background(Tokens.SurfaceRaised)
            .border(1.dp, Tokens.BorderStrong, shape)
            .padding(6.dp),
    ) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 4.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (draft.isEmpty()) {
                Text(placeholder, color = Tokens.TextDim, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            BasicTextField(
                value = shown,
                onValueChange = {
                    field = it
                    if (it.text != draft) onDraftChange(it.text)
                },
                textStyle = TextStyle(color = Tokens.Text, fontSize = Tokens.TextLg, lineHeight = 22.sp),
                cursorBrush = SolidColor(Tokens.Text),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                maxLines = 6,
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            )
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            if (canAttach) AddMenu(uploading, onAttachPhoto, onAttachFile, onOpen = { focus.clearFocus() })
            // The options take what the buttons leave, so on a narrow phone
            // the chip shortens rather than pushing Send off the edge.
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) { options?.invoke() }
            Spacer(Modifier.width(Tokens.Space1))
            // While a turn runs the button stops it — until something is typed:
            // then it sends, and the agent reads the message when it can.
            val stop = onStop != null && !canSend
            val action = when {
                canSend -> onSend
                stop -> onStop
                else -> onDictate
            }
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(if (canSend || stop) Tokens.Accent else Tokens.SurfaceHover)
                    .combinedClickable(
                        onClickLabel = when {
                            canSend -> "Send"
                            stop -> "Stop"
                            else -> "Dictate with voice"
                        },
                        onLongClickLabel = "Dictate with voice",
                        onLongClick = onDictate,
                        onClick = action,
                    )
                    .semantics { contentDescription = if (canSend) "Send" else if (stop) "Stop" else "Dictate with voice" },
                contentAlignment = Alignment.Center,
            ) {
                when {
                    stop -> Box(Modifier.size(13.dp).clip(RoundedCornerShape(3.dp)).background(Tokens.AccentContrast))
                    canSend -> Icon(
                        Icons.AutoMirrored.Outlined.ArrowForward,
                        contentDescription = null,
                        tint = Tokens.AccentContrast,
                        modifier = Modifier.size(20.dp),
                    )
                    else -> Icon(Icons.Outlined.Mic, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

/** The `+` button and what it adds: a photo or a file, both dimmed while
 *  one uploads. */
@Composable
private fun AddMenu(uploading: Boolean, onAttachPhoto: () -> Unit, onAttachFile: () -> Unit, onOpen: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .border(1.dp, Tokens.BorderStrong, CircleShape)
                .clickable {
                    onOpen()
                    open = true
                }
                .semantics { contentDescription = "Add" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Add, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(22.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.background(Tokens.SurfaceRaised)) {
            AddChoice("Photo", Icons.Outlined.Image, enabled = !uploading) {
                open = false
                onAttachPhoto()
            }
            AddChoice("File", Icons.Outlined.Description, enabled = !uploading) {
                open = false
                onAttachFile()
            }
        }
    }
}

@Composable
private fun AddChoice(label: String, icon: ImageVector, enabled: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, color = if (enabled) Tokens.Text else Tokens.TextDim, fontSize = Tokens.TextMd) },
        leadingIcon = { Icon(icon, contentDescription = null, tint = if (enabled) Tokens.TextMuted else Tokens.TextDim) },
        onClick = onClick,
        enabled = enabled,
    )
}

/** The user's quick prompts as pills above the input; a tap puts the text in the draft, never sends. */
@Composable
internal fun QuickPromptStrip(prompts: List<UniffiQuickPrompt>, onInsert: (String) -> Unit) {
    if (prompts.isEmpty()) return
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space1),
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        prompts.forEach { prompt ->
            Text(
                prompt.label,
                color = Tokens.Text,
                fontSize = Tokens.TextSm,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .widthIn(max = 180.dp)
                    .clip(RoundedCornerShape(Tokens.RadiusPill))
                    .background(Tokens.SurfaceHover)
                    .clickable { onInsert(prompt.text) }
                    .padding(horizontal = Tokens.Space4, vertical = Tokens.Space2),
            )
        }
    }
}
