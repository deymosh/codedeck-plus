package com.codedeck.plus.ui.screens

import com.codedeck.plus.R
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.colorResource
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.Image
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
        // Fits the screen: the hero at the top, the choices at the bottom,
        // the space between them taking up the slack. It scrolls only when
        // it cannot fit (the keyboard up for an import, a small screen at a
        // large font size).
        Column(
            Modifier
                // Keeps the column readable on a tablet.
                .widthIn(max = 560.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .heightIn(min = screenHeight)
                .padding(horizontal = Tokens.Space5, vertical = Tokens.Space4),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Hero()

            Column(
                Modifier.padding(top = Tokens.Space5),
                verticalArrangement = Arrangement.spacedBy(Tokens.Space3),
            ) {
                SignerCard(signers, busy, onUseSigner)
                OptionCard(
                    icon = Icons.Outlined.Key,
                    title = "Create a new key",
                    body = "Kept in the Android Keystore.",
                    busy = busy == WelcomeBusy.Key && !importOpen,
                    enabled = busy == null,
                    onClick = onCreateKey,
                )
                ImportCard(
                    open = importOpen,
                    text = importText,
                    busy = busy == WelcomeBusy.Key && importOpen,
                    enabled = busy == null,
                    onToggle = { importOpen = !importOpen },
                    onTextChange = { importText = it },
                    onImport = { onImportKey(importText) },
                )
                if (error != null) {
                    Text(error, color = Tokens.Danger, fontSize = Tokens.TextSm)
                }
            }
        }
    }
}

@Composable
private fun Hero() {
    Column(verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            // The launcher icon: its foreground on its background colour,
            // scaled so the mark fills the tile as the launcher's safe zone
            // (66dp of a 108dp canvas) does.
            Box(
                Modifier
                    .size(48.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(colorResource(R.color.ic_launcher_background))
                    .border(
                        BorderStroke(1.dp, Brush.linearGradient(listOf(Color.White.copy(alpha = 0.6f), Tokens.BorderStrong))),
                        RoundedCornerShape(14.dp),
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painterResource(R.drawable.ic_launcher_foreground),
                    contentDescription = null,
                    modifier = Modifier.requiredSize(48.dp * 108f / 66f),
                )
            }
            Text("CodeDeck+", color = Tokens.Text, fontSize = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp)
        }
        Text(
            "Drive your coding agents from your phone.",
            color = Tokens.Text,
            fontSize = Tokens.TextLg,
            lineHeight = 22.sp,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Tokens.Space2)) {
            Pill("End-to-end encrypted")
            Pill("Nostr")
            Pill("Tor-ready")
        }
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
private fun SignerCard(signers: List<SignerAppInfo>, busy: WelcomeBusy?, onUseSigner: (SignerAppInfo) -> Unit) {
    Card(highlight = true) {
        Column(Modifier.padding(Tokens.Space3), verticalArrangement = Arrangement.spacedBy(Tokens.Space3)) {
            CardHeader(
                icon = Icons.Outlined.Shield,
                title = "Use a signer app",
                body = "Your key stays in a NIP-55 signer: one identity across reinstalls.",
                badge = "RECOMMENDED",
            )
            if (signers.isEmpty()) {
                Text(
                    "No signer app found. Install one (Amber, for example), then come back.",
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
private fun SignerRow(signer: SignerAppInfo, busy: Boolean, enabled: Boolean, onClick: () -> Unit) {
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
        Text(
            signer.label,
            color = Tokens.Text,
            fontSize = Tokens.TextMd,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.Text)
        } else {
            Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = Tokens.TextMuted)
        }
    }
}

@Composable
private fun OptionCard(
    icon: ImageVector,
    title: String,
    body: String,
    busy: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    Card {
        Box(Modifier.clickable(enabled = enabled, onClick = onClick).padding(Tokens.Space3)) {
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
            Box(Modifier.clickable(enabled = enabled, onClick = onToggle).padding(Tokens.Space3)) {
                CardHeader(
                    icon = Icons.Outlined.Download,
                    title = "Import a key",
                    body = "Paste an nsec; kept encrypted here.",
                )
            }
            AnimatedVisibility(open) {
                // The field and its button share a row: the screen fits
                // with the import open too.
                Row(
                    Modifier.padding(start = Tokens.Space3, end = Tokens.Space3, bottom = Tokens.Space3),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Tokens.Space2),
                ) {
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
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = onImport,
                        enabled = enabled && text.isNotBlank(),
                        colors = ButtonDefaults.buttonColors(containerColor = Tokens.Accent, contentColor = Tokens.AccentContrast),
                        shape = RoundedCornerShape(Tokens.RadiusMd),
                        modifier = Modifier.heightIn(min = 56.dp),
                    ) {
                        if (busy) {
                            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = Tokens.AccentContrast)
                        } else {
                            Text("Import", fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
        }
    }
}
