package com.codedeck.plus.ui.screens

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.exclude
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.codedeck.plus.R
import com.codedeck.plus.platform.SignerAppInfo
import com.codedeck.plus.ui.theme.Tokens

/** What the welcome screen is waiting on, if anything. */
sealed interface WelcomeBusy {
    /** A signer app is being asked for the public key. */
    data class Signer(val packageName: String) : WelcomeBusy
    data object Key : WelcomeBusy
}

/**
 * The first screen of a fresh install: what the app is, then how to hold
 * the Nostr identity it pairs with — a NIP-55 signer app, a new key on this
 * device, or an imported one. The core only starts after a choice. Pure:
 * every action is a callback, so it renders the same in a snapshot.
 *
 * It does not scroll on a phone. It is laid out roomy (the full pitch, the
 * signer apps' package names, a footnote) while that fits, and compact once
 * it would not (a shorter screen, the import open, an error). The fit is
 * judged against the screen without the keyboard, so the keyboard never
 * switches it. Only when even compact cannot fit (the keyboard up, a small
 * screen at a large font size) does it scroll.
 */
@Composable
fun WelcomeScreen(
    signers: List<SignerAppInfo>,
    busy: WelcomeBusy?,
    error: String?,
    onUseSigner: (SignerAppInfo) -> Unit,
    onCreateKey: () -> Unit,
    onImportKey: (String) -> Unit,
    importInitiallyOpen: Boolean = false,
) {
    var importOpen by rememberSaveable { mutableStateOf(importInitiallyOpen) }
    var importText by rememberSaveable { mutableStateOf("") }

    BoxWithConstraints(
        Modifier
            .fillMaxSize()
            .background(Tokens.Bg)
            .background(
                Brush.radialGradient(
                    colors = listOf(Color.White.copy(alpha = 0.10f), Color.Transparent),
                    center = androidx.compose.ui.geometry.Offset(540f, 0f),
                    radius = 900f,
                ),
            ),
        contentAlignment = Alignment.TopCenter,
    ) {
        val screenHeight = maxHeight
        // The height without the keyboard: the app pads for it (beyond the
        // navigation bar it covers), so add that back.
        val keyboard = WindowInsets.ime.exclude(WindowInsets.systemBars).asPaddingValues().calculateBottomPadding()
        PickDensity(
            available = screenHeight + keyboard,
            roomyProbe = {
                Content(
                    roomy = true,
                    signers = signers,
                    busy = busy,
                    error = error,
                    importOpen = importOpen,
                    importText = importText,
                    onUseSigner = {},
                    onCreateKey = {},
                    onToggleImport = {},
                    onImportText = {},
                    onImport = {},
                )
            },
        ) { roomy ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .heightIn(min = screenHeight),
                contentAlignment = Alignment.Center,
            ) {
                Content(
                    roomy = roomy,
                    signers = signers,
                    busy = busy,
                    error = error,
                    importOpen = importOpen,
                    importText = importText,
                    onUseSigner = onUseSigner,
                    onCreateKey = onCreateKey,
                    onToggleImport = { importOpen = !importOpen },
                    onImportText = { importText = it },
                    onImport = { onImportKey(importText) },
                )
            }
        }
    }
}

/** Lays out `content(true)` when `roomyProbe` (the roomy layout, measured
 *  but never shown) fits in `available`, else `content(false)`. */
@Composable
private fun PickDensity(available: Dp, roomyProbe: @Composable () -> Unit, content: @Composable (roomy: Boolean) -> Unit) {
    SubcomposeLayout { constraints ->
        val probe = subcompose("probe", roomyProbe).map { it.measure(Constraints(maxWidth = constraints.maxWidth)) }
        val roomy = probe.sumOf { it.height } <= available.roundToPx()
        val placeables = subcompose(roomy) { content(roomy) }.map { it.measure(constraints) }
        layout(constraints.maxWidth, placeables.maxOfOrNull { it.height } ?: 0) {
            placeables.forEach { it.place(0, 0) }
        }
    }
}

/** The screen's content, roomy or compact; stateless. */
@Composable
private fun Content(
    roomy: Boolean,
    signers: List<SignerAppInfo>,
    busy: WelcomeBusy?,
    error: String?,
    importOpen: Boolean,
    importText: String,
    onUseSigner: (SignerAppInfo) -> Unit,
    onCreateKey: () -> Unit,
    onToggleImport: () -> Unit,
    onImportText: (String) -> Unit,
    onImport: () -> Unit,
) {
    Column(
        Modifier
            // Keeps the column readable on a tablet.
            .widthIn(max = 560.dp)
            .fillMaxWidth()
            .padding(horizontal = Tokens.Space5, vertical = if (roomy) Tokens.Space6 else Tokens.Space4),
        verticalArrangement = Arrangement.spacedBy(if (roomy) Tokens.Space6 else Tokens.Space5),
    ) {
        Hero(roomy)

        Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            if (roomy) SectionLabel("Your identity")
            SignerCard(roomy, signers, busy, onUseSigner)
            OptionCard(
                roomy = roomy,
                icon = Icons.Outlined.Key,
                title = if (roomy) "Create a key on this device" else "Create a new key",
                body = if (roomy) "A fresh Nostr key, encrypted by the Android Keystore." else "Kept in the Android Keystore.",
                busy = busy == WelcomeBusy.Key && !importOpen,
                enabled = busy == null,
                onClick = onCreateKey,
            )
            ImportCard(
                roomy = roomy,
                open = importOpen,
                text = importText,
                busy = busy == WelcomeBusy.Key && importOpen,
                enabled = busy == null,
                onToggle = onToggleImport,
                onTextChange = onImportText,
                onImport = onImport,
            )
            if (error != null) {
                Text(error, color = Tokens.Danger, fontSize = Tokens.TextSm)
            }
        }

        if (roomy) {
            Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Icon(Icons.Outlined.Shield, contentDescription = null, tint = Tokens.TextDim, modifier = Modifier.size(16.dp))
                Text(
                    "A signer app keeps your key outside CodeDeck+, so you stay the same identity across reinstalls and apps.",
                    color = Tokens.TextMuted,
                    fontSize = Tokens.TextXs,
                    lineHeight = 16.sp,
                )
            }
        }
    }
}

@Composable
private fun Hero(roomy: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        if (roomy) {
            Logo(64.dp)
            Text("CodeDeck+", color = Tokens.Text, fontSize = 34.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp)
            Text(
                "Drive your coding agents from your phone.",
                color = Tokens.Text,
                fontSize = Tokens.TextXl,
                lineHeight = 26.sp,
            )
            Text(
                "Claude Code, OpenCode and friends run on your machine; you steer them from here.",
                color = Tokens.TextMuted,
                fontSize = Tokens.TextMd,
                lineHeight = 20.sp,
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
                Logo(48.dp)
                Text("CodeDeck+", color = Tokens.Text, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp)
            }
            Text(
                "Drive your coding agents from your phone.",
                color = Tokens.Text,
                fontSize = Tokens.TextLg,
                lineHeight = 22.sp,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Pill("End-to-end encrypted")
            Pill("Nostr")
            Pill("Tor-ready")
        }
    }
}

/** The launcher icon: its foreground on its background colour, scaled so
 *  the mark fills the tile as the launcher's safe zone (66dp of a 108dp
 *  canvas) does. */
@Composable
private fun Logo(size: Dp) {
    val corner = RoundedCornerShape(size * 0.29f)
    Box(
        Modifier
            .size(size)
            .clip(corner)
            .background(colorResource(R.color.ic_launcher_background))
            .border(
                BorderStroke(1.dp, Brush.linearGradient(listOf(Color.White.copy(alpha = 0.6f), Tokens.BorderStrong))),
                corner,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painterResource(R.drawable.ic_launcher_foreground),
            contentDescription = null,
            modifier = Modifier.requiredSize(size * 108f / 66f),
        )
    }
}

@Composable
private fun Pill(text: String) {
    Text(
        text,
        color = Tokens.TextMuted,
        fontSize = Tokens.TextXs,
        modifier = Modifier
            .border(1.dp, Tokens.BorderStrong, RoundedCornerShape(Tokens.RadiusPill))
            .padding(horizontal = Tokens.Space2, vertical = Tokens.Space1),
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        color = Tokens.TextDim,
        fontSize = Tokens.TextXs,
        letterSpacing = 1.2.sp,
        fontWeight = FontWeight.Medium,
    )
}

private fun cardPadding(roomy: Boolean): Dp = if (roomy) Tokens.Space4 else Tokens.Space3

@Composable
private fun Card(highlight: Boolean = false, content: @Composable () -> Unit) {
    Surface(
        color = Tokens.SurfaceRaised,
        contentColor = Tokens.Text,
        shape = RoundedCornerShape(Tokens.RadiusLg),
        border = BorderStroke(1.dp, if (highlight) Tokens.BorderStrong else Tokens.Border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        content()
    }
}

@Composable
private fun CardHeader(icon: ImageVector, title: String, body: String, badge: String? = null, trailing: @Composable () -> Unit = {}) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Box(
            Modifier.size(40.dp).clip(RoundedCornerShape(Tokens.RadiusMd)).background(Tokens.SurfaceHover),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = Tokens.Text, modifier = Modifier.size(20.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                Text(title, color = Tokens.Text, fontSize = Tokens.TextLg, fontWeight = FontWeight.Medium)
                if (badge != null) {
                    Text(
                        badge,
                        color = Tokens.AccentContrast,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        letterSpacing = 0.6.sp,
                        modifier = Modifier
                            .clip(RoundedCornerShape(Tokens.RadiusPill))
                            .background(Tokens.Accent)
                            .padding(horizontal = 6.dp, vertical = 1.dp),
                    )
                }
            }
            Text(body, color = Tokens.TextMuted, fontSize = Tokens.TextSm, lineHeight = 18.sp)
        }
        trailing()
    }
}

@Composable
private fun SignerCard(roomy: Boolean, signers: List<SignerAppInfo>, busy: WelcomeBusy?, onUseSigner: (SignerAppInfo) -> Unit) {
    Card(highlight = true) {
        Column(Modifier.padding(cardPadding(roomy)), verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            CardHeader(
                icon = Icons.Outlined.Shield,
                title = "Use a signer app",
                body = if (roomy) {
                    "Your key stays in a NIP-55 signer; CodeDeck+ asks it to sign."
                } else {
                    "Your key stays in a NIP-55 signer: one identity across reinstalls."
                },
                badge = "RECOMMENDED",
            )
            if (signers.isEmpty()) {
                Text(
                    "No signer app found on this phone. Install one (Amber, for example), then come back.",
                    color = Tokens.TextDim,
                    fontSize = Tokens.TextSm,
                    lineHeight = 18.sp,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(Tokens.RadiusMd))
                        .background(Tokens.SurfaceInput)
                        .padding(Tokens.Space3),
                )
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                    for (signer in signers) {
                        SignerRow(
                            roomy = roomy,
                            signer = signer,
                            busy = busy == WelcomeBusy.Signer(signer.packageName),
                            enabled = busy == null,
                            onClick = { onUseSigner(signer) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SignerRow(roomy: Boolean, signer: SignerAppInfo, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Tokens.TapMin)
            .clip(RoundedCornerShape(Tokens.RadiusMd))
            .background(Tokens.SurfaceInput)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = Tokens.Space3, vertical = Tokens.Space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Tokens.Space3),
    ) {
        Box(
            Modifier.size(32.dp).clip(CircleShape).background(Tokens.Accent),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                signer.label.take(1).uppercase(),
                color = Tokens.AccentContrast,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.Bold,
            )
        }
        Column(Modifier.weight(1f)) {
            Text(
                signer.label,
                color = Tokens.Text,
                fontSize = Tokens.TextMd,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (roomy) {
                Text(
                    signer.packageName,
                    color = Tokens.TextDim,
                    fontSize = Tokens.TextXs,
                    fontFamily = Tokens.FontMono,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.Text)
        } else {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.TextMuted)
        }
    }
}

@Composable
private fun OptionCard(
    roomy: Boolean,
    icon: ImageVector,
    title: String,
    body: String,
    busy: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Card {
        Box(Modifier.clickable(enabled = enabled, onClick = onClick).padding(cardPadding(roomy))) {
            CardHeader(icon, title, body) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.Text)
                } else {
                    Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.TextMuted)
                }
            }
        }
    }
}

@Composable
private fun ImportCard(
    roomy: Boolean,
    open: Boolean,
    text: String,
    busy: Boolean,
    enabled: Boolean,
    onToggle: () -> Unit,
    onTextChange: (String) -> Unit,
    onImport: () -> Unit,
) {
    Card {
        Column {
            Box(Modifier.clickable(enabled = enabled, onClick = onToggle).padding(cardPadding(roomy))) {
                CardHeader(
                    icon = Icons.Outlined.Download,
                    title = if (roomy) "Import an existing key" else "Import a key",
                    body = if (roomy) "Paste an nsec; it is stored encrypted on this device." else "Paste an nsec; kept encrypted here.",
                )
            }
            AnimatedVisibility(open) {
                val pad = Modifier.padding(start = cardPadding(roomy), end = cardPadding(roomy), bottom = cardPadding(roomy))
                val canImport = enabled && text.isNotBlank()
                if (roomy) {
                    Column(pad, verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
                        KeyField(text, onTextChange, Modifier.fillMaxWidth())
                        ImportButton(canImport, busy, "Import key", onImport, Modifier.fillMaxWidth().heightIn(min = Tokens.TapMin))
                    }
                } else {
                    // The field and its button share a row, to fit.
                    Row(pad, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
                        KeyField(text, onTextChange, Modifier.weight(1f))
                        ImportButton(canImport, busy, "Import", onImport, Modifier.heightIn(min = 56.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun KeyField(text: String, onTextChange: (String) -> Unit, modifier: Modifier) {
    OutlinedTextField(
        value = text,
        onValueChange = onTextChange,
        placeholder = { Text("nsec1…", color = Tokens.TextDim) },
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Tokens.Text,
            unfocusedBorderColor = Tokens.BorderStrong,
            focusedContainerColor = Tokens.SurfaceInput,
            unfocusedContainerColor = Tokens.SurfaceInput,
        ),
        shape = RoundedCornerShape(Tokens.RadiusMd),
        modifier = modifier,
    )
}

@Composable
private fun ImportButton(enabled: Boolean, busy: Boolean, label: String, onClick: () -> Unit, modifier: Modifier) {
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = Tokens.Accent, contentColor = Tokens.AccentContrast),
        shape = RoundedCornerShape(Tokens.RadiusMd),
        modifier = modifier,
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.AccentContrast)
        } else {
            Text(label, fontWeight = FontWeight.Medium)
        }
    }
}
