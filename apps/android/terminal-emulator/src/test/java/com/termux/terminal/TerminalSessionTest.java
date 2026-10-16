package com.termux.terminal;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * The remote session is the only place the emulator meets the shell, so these
 * pin the three directions it carries: bytes in from the shell, the user's
 * input out, and the terminal size out. A plain JVM test — the emulator is
 * pure Java, and with no main looper the session appends inline instead of
 * posting to a handler.
 */
public class TerminalSessionTest {

    private static final int COLUMNS = 20;
    private static final int ROWS = 5;

    private static final class RecordingCallbacks implements TerminalSessionCallbacks {
        final List<byte[]> inputs = new ArrayList<>();
        int lastColumns = -1;
        int lastRows = -1;

        @Override
        public void onInput(byte[] data) {
            inputs.add(data);
        }

        @Override
        public void onResize(int columns, int rows) {
            lastColumns = columns;
            lastRows = rows;
        }
    }

    private static TerminalSession sizedSession(RecordingCallbacks callbacks) {
        TerminalSession session = new TerminalSession(ROWS * 2, null, callbacks);
        session.updateSize(COLUMNS, ROWS, 13, 15);
        return session;
    }

    @Test
    public void feedAppendsToTheEmulatorAndMovesTheCursor() {
        TerminalSession session = sizedSession(new RecordingCallbacks());

        session.feed("hi\r\n\u001b[1mbold".getBytes(StandardCharsets.UTF_8));

        TerminalEmulator emulator = session.getEmulator();
        assertEquals("hi", emulator.getScreen().getSelectedText(0, 0, COLUMNS, 0));
        assertEquals(1, emulator.getCursorRow());
        assertEquals(4, emulator.getCursorCol());
    }

    @Test
    public void feedBeforeTheFirstSizeIsReplayedOnceTheEmulatorExists() {
        TerminalSession session = new TerminalSession(ROWS * 2, null, new RecordingCallbacks());

        // The shell's replay of its screen arrives right after attach, before
        // the view has been laid out and called updateSize.
        session.feed("hi".getBytes(StandardCharsets.UTF_8));
        assertNull(session.getEmulator());

        session.updateSize(COLUMNS, ROWS, 13, 15);

        assertEquals("hi", session.getEmulator().getScreen().getSelectedText(0, 0, COLUMNS, 0));
    }

    @Test
    public void resizeReachesTheCallbacks() {
        RecordingCallbacks callbacks = new RecordingCallbacks();

        sizedSession(callbacks);

        assertEquals(COLUMNS, callbacks.lastColumns);
        assertEquals(ROWS, callbacks.lastRows);
    }

    @Test
    public void writtenInputReachesTheCallbacks() {
        RecordingCallbacks callbacks = new RecordingCallbacks();
        TerminalSession session = sizedSession(callbacks);

        session.write("ls\n");

        assertEquals(1, callbacks.inputs.size());
        assertArrayEquals("ls\n".getBytes(StandardCharsets.UTF_8), callbacks.inputs.get(0));
    }

    @Test
    public void alternateScreenEscapeSequenceTogglesTheFlag() {
        TerminalSession session = sizedSession(new RecordingCallbacks());
        assertFalse(session.isAlternateBufferActive());

        session.feed("\u001b[?1049h".getBytes(StandardCharsets.UTF_8));

        assertTrue(session.isAlternateBufferActive());
    }
}
