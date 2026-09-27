package com.codedeck.plus.ui.session

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.codedeck.plus.ui.theme.Tokens
import uniffi.client_ffi.UniffiQuickPrompt

/**
 * The message input: attach, the text, dictation, and a round Send that
 * lights up once there is something to send. One rounded surface, so the
 * controls read as parts of the input rather than a row of buttons.
 */
@Composable
internal fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    placeholder: String,
    canAttach: Boolean,
    uploading: Boolean,
    canSend: Boolean,
    onAttach: () -> Unit,
    onDictate: () -> Unit,
    onSend: () -> Unit,
    focusRequester: FocusRequester = FocusRequester(),
) {
    val shape = RoundedCornerShape(26.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2)
            .clip(shape)
            .background(Tokens.SurfaceRaised)
            .border(1.dp, Tokens.BorderStrong, shape)
            .padding(start = Tokens.Space1, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        if (canAttach) {
            // Dimmed while an upload runs, so the disabled state is visible.
            IconButton(onClick = onAttach, enabled = !uploading) {
                Icon(Icons.Outlined.AttachFile, contentDescription = "Attach image", tint = if (uploading) Tokens.TextDim else Tokens.TextMuted)
            }
        } else {
            Box(Modifier.size(Tokens.Space3))
        }
        Box(
            Modifier.weight(1f).heightIn(min = 48.dp).padding(vertical = 12.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            if (draft.isEmpty()) {
                Text(placeholder, color = Tokens.TextDim, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            BasicTextField(
                value = draft,
                onValueChange = onDraftChange,
                textStyle = TextStyle(color = Tokens.Text, fontSize = Tokens.TextLg, lineHeight = 22.sp),
                cursorBrush = SolidColor(Tokens.Text),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                maxLines = 6,
                modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
            )
        }
        IconButton(onClick = onDictate) {
            Icon(Icons.Outlined.Mic, contentDescription = "Dictate with voice", tint = Tokens.TextMuted)
        }
        Box(
            Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(if (canSend) Tokens.Accent else Tokens.SurfaceHover)
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.AutoMirrored.Outlined.ArrowForward,
                contentDescription = "Send",
                tint = if (canSend) Tokens.AccentContrast else Tokens.TextDim,
                modifier = Modifier.size(22.dp),
            )
        }
    }
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
