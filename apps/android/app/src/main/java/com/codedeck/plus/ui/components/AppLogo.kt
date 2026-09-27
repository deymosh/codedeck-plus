package com.codedeck.plus.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.codedeck.plus.R
import com.codedeck.plus.ui.theme.Tokens

/** The launcher icon: its foreground on its background colour, scaled so
 *  the mark fills the tile as the launcher's safe zone (66dp of a 108dp
 *  canvas) does. */
@Composable
fun AppLogo(size: Dp) {
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
