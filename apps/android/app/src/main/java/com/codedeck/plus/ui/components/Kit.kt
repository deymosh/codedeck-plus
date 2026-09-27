package com.codedeck.plus.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.codedeck.plus.ui.theme.Tokens

/*
 * The building blocks every page is made of, so pages differ in content
 * only: a page frame with its back arrow and title, grouped blocks of rows
 * (one surface per group, hairlines between its rows), the row kinds
 * settings need, and the buttons and fields. Everything here is stateless.
 */

/** The soft white light the welcome screen and the home page open under. */
fun Modifier.topGlow(): Modifier = background(
    Brush.radialGradient(
        colors = listOf(Color.White.copy(alpha = 0.09f), Color.Transparent),
        center = Offset(540f, -120f),
        radius = 900f,
    ),
)

/**
 * A full page: a back arrow and the page's title (with an optional line
 * under it), then [content] scrolling under them. [actions] sit at the end
 * of the title bar; [bottomBar] stays pinned below the content.
 */
@Composable
fun Page(
    title: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    backLabel: String = "Back",
    subtitle: String? = null,
    actions: @Composable RowScope.() -> Unit = {},
    scroll: Boolean = true,
    bottomBar: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxSize().background(Tokens.Bg)) {
        Row(
            Modifier.fillMaxWidth().padding(start = Tokens.Space1, end = Tokens.Space2, top = Tokens.Space2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconAction(Icons.AutoMirrored.Outlined.ArrowBack, backLabel, onBack)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                actions()
            }
        }
        Text(
            title,
            color = Tokens.Text,
            fontSize = Tokens.TextTitle,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = (-0.4).sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .padding(horizontal = Tokens.Space5)
                .padding(top = Tokens.Space1, bottom = if (subtitle == null) Tokens.Space4 else 2.dp),
        )
        if (subtitle != null) {
            Text(
                subtitle,
                color = Tokens.TextMuted,
                fontSize = Tokens.TextMd,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = Tokens.Space5).padding(bottom = Tokens.Space4),
            )
        }
        Column(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier)
                .padding(horizontal = Tokens.Space4)
                .padding(bottom = Tokens.Space6),
            verticalArrangement = Arrangement.spacedBy(Tokens.Space5),
            content = content,
        )
        if (bottomBar != null) {
            HorizontalDivider(thickness = 1.dp, color = Tokens.Border)
            Box(Modifier.fillMaxWidth().padding(horizontal = Tokens.Space4, vertical = Tokens.Space3)) { bottomBar() }
        }
    }
}

/** A round, touch-sized icon button for a title bar. */
@Composable
fun IconAction(icon: ImageVector, label: String, onClick: () -> Unit, tint: Color = Tokens.Text) {
    Box(
        Modifier
            .minimumInteractiveComponentSize()
            .size(44.dp)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(22.dp))
    }
}

/**
 * Rows that belong together, on one surface with hairlines between them.
 * [title] names the group above it; [footer] explains it below, in the
 * muted text a hint gets.
 */
@Composable
fun Group(
    title: String? = null,
    footer: String? = null,
    modifier: Modifier = Modifier,
    rows: @Composable GroupScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
        if (title != null) {
            Text(
                title,
                color = Tokens.TextMuted,
                fontSize = Tokens.TextSm,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(horizontal = Tokens.Space2),
            )
        }
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(Tokens.RadiusXl))
                .background(Tokens.SurfaceRaised)
                .border(1.dp, Tokens.Border, RoundedCornerShape(Tokens.RadiusXl)),
        ) {
            GroupScope.rows()
        }
        if (footer != null) {
            Text(
                footer,
                color = Tokens.TextDim,
                fontSize = Tokens.TextXs,
                lineHeight = 17.sp,
                modifier = Modifier.padding(horizontal = Tokens.Space2),
            )
        }
    }
}

/** Marks the composables meant to be a [Group]'s rows. */
object GroupScope {
    /** The hairline between two rows, inset past a leading icon. */
    @Composable
    fun Divider(inset: Dp = Tokens.Space4) {
        HorizontalDivider(Modifier.padding(start = inset), thickness = 1.dp, color = Tokens.Border)
    }
}

private val RowPadding = PaddingValues(horizontal = Tokens.Space4, vertical = 10.dp)

/** A leading icon in a small tile, for rows that open something. */
@Composable
fun RowIcon(icon: ImageVector, tint: Color = Tokens.Text) {
    Box(
        Modifier.size(36.dp).clip(RoundedCornerShape(Tokens.RadiusMd + 2.dp)).background(Tokens.SurfaceHover),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

/** Title with an optional line under it; takes the row's free width. */
@Composable
private fun RowScope.RowText(title: String, subtitle: String?, titleColor: Color = Tokens.Text, mono: Boolean = false) {
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, color = titleColor, fontSize = Tokens.TextLg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle != null) {
            Text(
                subtitle,
                color = Tokens.TextMuted,
                fontSize = Tokens.TextSm,
                fontFamily = if (mono) Tokens.FontMono else FontFamily.Default,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** A row that opens a page: optional icon, title, a short value or status, and a chevron. */
@Composable
fun NavRow(
    title: String,
    onClick: () -> Unit,
    subtitle: String? = null,
    icon: (@Composable () -> Unit)? = null,
    value: String? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(onClick = onClick)
            .padding(RowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        icon?.invoke()
        RowText(title, subtitle)
        if (value != null) {
            Text(value, color = Tokens.TextMuted, fontSize = Tokens.TextSm, maxLines = 1)
        }
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.TextDim)
    }
}

/** A setting that is on or off; the whole row toggles it. */
@Composable
fun SwitchRow(title: String, checked: Boolean, onChange: (Boolean) -> Unit, subtitle: String? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable { onChange(!checked) }
            .padding(RowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        RowText(title, subtitle)
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Tokens.AccentContrast,
                checkedTrackColor = Tokens.Accent,
                uncheckedThumbColor = Tokens.TextMuted,
                uncheckedTrackColor = Tokens.SurfaceInput,
                uncheckedBorderColor = Tokens.BorderStrong,
            ),
        )
    }
}

/** A labelled value with its control (a picker, a badge) at the end. */
@Composable
fun ValueRow(title: String, subtitle: String? = null, mono: Boolean = false, control: @Composable () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(RowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        RowText(title, subtitle, mono = mono)
        control()
    }
}

/** Free content inside a group, padded like a row. */
@Composable
fun GroupBody(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(RowPadding),
        verticalArrangement = Arrangement.spacedBy(Tokens.Space3),
        content = content,
    )
}

/** A row that performs one action, in the action's colour (red when it destroys). */
@Composable
fun ActionRow(title: String, onClick: () -> Unit, danger: Boolean = false, icon: ImageVector? = null) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clickable(onClick = onClick)
            .padding(RowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        val color = if (danger) Tokens.Danger else Tokens.Text
        if (icon != null) Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
        Text(title, color = color, fontSize = Tokens.TextLg)
    }
}

/** A small filled dot saying live / waiting / off. */
@Composable
fun Dot(color: Color, size: Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(color))
}

/** A quiet rounded label (a host kind, a status). */
@Composable
fun Chip(text: String, color: Color = Tokens.TextMuted, border: Color = Tokens.BorderStrong) {
    Text(
        text,
        color = color,
        fontSize = Tokens.TextXs,
        maxLines = 1,
        modifier = Modifier
            .border(1.dp, border, RoundedCornerShape(Tokens.RadiusPill))
            .padding(horizontal = Tokens.Space2, vertical = 2.dp),
    )
}

/** The one filled, white button a page's main action gets. */
@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, icon: ImageVector? = null) {
    Button(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(Tokens.RadiusPill),
        colors = ButtonDefaults.buttonColors(
            containerColor = Tokens.Accent,
            contentColor = Tokens.AccentContrast,
            disabledContainerColor = Tokens.SurfaceHover,
            disabledContentColor = Tokens.TextDim,
        ),
        contentPadding = PaddingValues(horizontal = Tokens.Space5, vertical = Tokens.Space3),
        modifier = modifier.heightIn(min = Tokens.TapMin),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Box(Modifier.size(Tokens.Space2))
        }
        Text(text, fontWeight = FontWeight.SemiBold, fontSize = Tokens.TextMd)
    }
}

/** An outlined button for the actions next to the main one. */
@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, danger: Boolean = false) {
    val color = if (danger) Tokens.Danger else Tokens.Text
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(Tokens.RadiusPill),
        border = BorderStroke(1.dp, if (enabled) Tokens.BorderStrong else Tokens.Border),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = color, disabledContentColor = Tokens.TextDim),
        contentPadding = PaddingValues(horizontal = Tokens.Space4, vertical = Tokens.Space2),
        modifier = modifier.heightIn(min = 44.dp),
    ) {
        Text(text, fontSize = Tokens.TextMd)
    }
}

/** A text-only button for low-emphasis actions (Cancel, Edit). */
@Composable
fun QuietButton(text: String, onClick: () -> Unit, danger: Boolean = false, enabled: Boolean = true) {
    TextButton(onClick = onClick, enabled = enabled, shape = RoundedCornerShape(Tokens.RadiusPill)) {
        Text(text, color = if (!enabled) Tokens.TextDim else if (danger) Tokens.Danger else Tokens.TextMuted, fontSize = Tokens.TextMd)
    }
}

/** The text field every form uses. */
@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    label: String? = null,
    supporting: String? = null,
    isError: Boolean = false,
    singleLine: Boolean = true,
    mono: Boolean = false,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        placeholder = placeholder?.let { { Text(it, color = Tokens.TextDim) } },
        label = label?.let { { Text(it) } },
        supportingText = supporting?.let { { Text(it) } },
        isError = isError,
        singleLine = singleLine,
        visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions,
        textStyle = androidx.compose.ui.text.TextStyle(
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
            fontFamily = if (mono) Tokens.FontMono else FontFamily.Default,
        ),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Tokens.Text,
            unfocusedBorderColor = Tokens.BorderStrong,
            focusedContainerColor = Tokens.SurfaceInput,
            unfocusedContainerColor = Tokens.SurfaceInput,
            focusedLabelColor = Tokens.Text,
            unfocusedLabelColor = Tokens.TextMuted,
            cursorColor = Tokens.Text,
        ),
        shape = RoundedCornerShape(Tokens.RadiusLg),
        modifier = modifier.fillMaxWidth(),
    )
}

/** A centred invitation for an empty page: a large icon, what to do, and the button to do it. */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String,
    action: String,
    onAction: () -> Unit,
    modifier: Modifier = Modifier,
    actionIcon: ImageVector? = null,
) {
    Column(
        modifier.widthIn(max = 420.dp).padding(horizontal = Tokens.Space6),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Box(
            Modifier
                .size(88.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(Tokens.SurfaceRaised)
                .border(1.dp, Brush.linearGradient(listOf(Color.White.copy(alpha = 0.35f), Tokens.Border)), RoundedCornerShape(28.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(40.dp))
        }
        Text(
            title,
            color = Tokens.Text,
            fontSize = Tokens.TextXl,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = Tokens.Space2),
        )
        Text(
            body,
            color = Tokens.TextMuted,
            fontSize = Tokens.TextMd,
            lineHeight = 20.sp,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        PrimaryButton(action, onAction, Modifier.padding(top = Tokens.Space3), icon = actionIcon)
    }
}
