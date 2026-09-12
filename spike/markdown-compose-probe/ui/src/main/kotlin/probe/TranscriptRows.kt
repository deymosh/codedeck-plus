package probe

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor

// CodeDeck is dark-only, near-black monochrome (src/styles/tokens.css).
private val bg = Color(0xFF000000)
private val surface = Color(0xFF0A0A0A)
private val border = Color(0xFF1A1A1A)
private val textDim = Color(0xFF999999)
private val add = Color(0xFF22C55E)
private val del = Color(0xFFEF4444)

@Composable
fun CodeDeckDark(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = bg, surface = surface, onBackground = Color(0xFFFFFFFF),
            onSurface = Color(0xFFFFFFFF), primary = Color(0xFFFFFFFF),
        ),
    ) {
        // Surface sets LocalContentColor = white, which is where the markdown
        // renderer's default text style now takes its colour from.
        Surface(color = bg, contentColor = Color(0xFFFFFFFF)) {
            Column(Modifier.background(bg).fillMaxWidth().padding(16.dp)) { content() }
        }
    }
}

/** The risky one: GFM markdown + fenced code, via the Compose-native renderer.
 *  Explicit white text — the m3 default resolves dark on this near-black theme. */
@Composable
fun AssistantMarkdown(md: String) {
    val white = Color(0xFFFFFFFF)
    val mono = TextStyle(color = Color(0xFFE0E0E0), fontFamily = FontFamily.Monospace, fontSize = 13.sp)
    // 0.27's Markdown(content) parses synchronously in composition — fine for a
    // static Paparazzi snapshot (newer versions moved to an async MarkdownState).
    Markdown(
        content = md,
        flavour = GFMFlavourDescriptor(),   // tables + task lists (default is CommonMark)
        colors = markdownColor(
            codeBackground = Color(0xFF0D0D0D),
            inlineCodeBackground = Color(0xFF0D0D0D),
            dividerColor = Color(0xFF333333),
        ),
        typography = markdownTypography(
            h1 = TextStyle(color = white, fontSize = 22.sp, fontWeight = FontWeight.Bold),
            h2 = TextStyle(color = white, fontSize = 18.sp, fontWeight = FontWeight.Bold),
            h3 = TextStyle(color = white, fontSize = 16.sp, fontWeight = FontWeight.Bold),
            h4 = TextStyle(color = white, fontSize = 15.sp, fontWeight = FontWeight.Bold),
            h5 = TextStyle(color = white, fontSize = 14.sp, fontWeight = FontWeight.Bold),
            h6 = TextStyle(color = white, fontSize = 13.sp, fontWeight = FontWeight.Bold),
            text = TextStyle(color = white, fontSize = 14.sp),
            paragraph = TextStyle(color = white, fontSize = 14.sp),
            ordered = TextStyle(color = white, fontSize = 14.sp),
            bullet = TextStyle(color = white, fontSize = 14.sp),
            list = TextStyle(color = white, fontSize = 14.sp),
            quote = TextStyle(color = Color(0xFF999999), fontSize = 14.sp),
            code = mono,
            inlineCode = mono,
        ),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun UserMessage(text: String) {
    Text(text, color = Color(0xFFFFFFFF), fontSize = 14.sp)
}

/** Bespoke — not markdown. A near-verbatim port target of DiffRow.tsx. */
@Composable
fun DiffCard(file: String, lines: List<Corpus.DiffLine>) {
    Column(
        Modifier.fillMaxWidth()
            .background(surface, RoundedCornerShape(8.dp))
            .padding(8.dp),
    ) {
        Text(file, color = textDim, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        lines.forEach { l ->
            val c = when (l.kind) {
                '+' -> add; '-' -> del; else -> textDim
            }
            Text("${l.kind}${l.text}", color = c, fontFamily = FontFamily.Monospace, fontSize = 12.sp)
        }
    }
}

/** Bespoke — a collapsed "N actions" tool group. */
@Composable
fun ToolGroup(items: List<String>) {
    Column(
        Modifier.fillMaxWidth()
            .background(surface, RoundedCornerShape(8.dp))
            .padding(8.dp),
    ) {
        Text("${items.size} actions", color = textDim, fontSize = 12.sp)
        items.forEach { Row { Text("• $it", color = Color(0xFFCCCCCC), fontSize = 13.sp) } }
    }
}
