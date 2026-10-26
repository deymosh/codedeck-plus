package com.termux.terminal;

import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.UUID;

/**
 * A terminal session: a {@link TerminalEmulator} fed by a shell that runs
 * elsewhere, plus the callbacks that carry the user's input and the terminal's
 * size back to that shell.
 * <p>
 * Upstream spawned a local pseudoterminal process through JNI and pumped bytes
 * to and from it. This session has no process: the shell lives on a remote
 * bridge, so {@link #feed(byte[])} appends the bytes it sends, the
 * {@link TerminalOutput#write(byte[], int, int)} paths hand what the user types
 * to {@link TerminalSessionCallbacks#onInput(byte[])}, and
 * {@link #updateSize(int, int, int, int)} reports the size through
 * {@link TerminalSessionCallbacks#onResize(int, int)}. All terminal emulation
 * and callback methods are performed on the main thread.
 * <p>
 * NOTE: The terminal session may outlive the EmulatorView, so be careful with callbacks!
 */
public final class TerminalSession extends TerminalOutput {

    public final String mHandle = UUID.randomUUID().toString();

    TerminalEmulator mEmulator;

    /** Callback which gets notified when a session changes title or state. */
    TerminalSessionClient mClient;

    /** Callback which forwards the user's input and size changes to the remote shell. */
    private final TerminalSessionCallbacks mCallbacks;

    /** Buffer to write translate code points into utf8 before writing to the remote shell. */
    private final byte[] mUtf8InputBuffer = new byte[5];

    /** Set by the application for user identification of session, not by terminal. */
    public String mSessionName;

    private final Integer mTranscriptRows;

    /** Created on first use, only when a feed arrives off the main thread. */
    private Handler mMainThreadHandler;

    /**
     * Output that arrives before the emulator exists (the view sizes the
     * session only once it is laid out, but the shell's replay of its screen so
     * far arrives as soon as the session is attached). Held in order and
     * appended when the emulator is created; bounded so a shell that floods the
     * session before the view is ready cannot grow it without limit — the
     * oldest bytes past {@link #MAX_PENDING_OUTPUT_BYTES} are dropped, since
     * the newest output is what the screen should end up showing.
     */
    private final ByteArrayOutputStream mPendingOutput = new ByteArrayOutputStream();

    private static final int MAX_PENDING_OUTPUT_BYTES = 512 * 1024;

    /**
     * Output fed off the main thread and not appended yet. Chunks that arrive
     * while one append is queued join it, so a flood of small chunks costs one
     * main-thread turn and one redraw per batch rather than per chunk — the
     * main thread also carries the user's keystrokes. Guarded by itself.
     */
    private final ByteArrayOutputStream mIncoming = new ByteArrayOutputStream();

    /** An append of {@link #mIncoming} is queued on the main thread. Guarded
     *  by {@link #mIncoming}. */
    private boolean mIncomingQueued;

    /**
     * @param transcriptRows how many lines of scrollback the emulator keeps.
     * @param client         the {@link TerminalSessionClient} implementation the emulator
     *                       reports titles, bells and clipboard events to.
     * @param callbacks      the {@link TerminalSessionCallbacks} implementation that
     *                       carries input and resizes to the remote shell.
     */
    public TerminalSession(Integer transcriptRows, TerminalSessionClient client, TerminalSessionCallbacks callbacks) {
        this.mTranscriptRows = transcriptRows;
        this.mClient = client;
        this.mCallbacks = callbacks;
    }

    /**
     * @param client The {@link TerminalSessionClient} interface implementation to allow
     *               for communication between {@link TerminalSession} and its client.
     */
    public void updateTerminalSessionClient(TerminalSessionClient client) {
        mClient = client;

        if (mEmulator != null)
            mEmulator.updateTerminalSessionClient(client);
    }

    /**
     * Feed bytes received from the remote shell into the emulator. Safe to call
     * from any thread: the bytes are appended on the main thread, then the
     * client is told to redraw. Bytes that arrive before the emulator exists
     * are buffered and replayed in order when it is created.
     */
    public void feed(byte[] data) {
        if (data == null || data.length == 0) return;
        synchronized (mIncoming) {
            mIncoming.write(data, 0, data.length);
            if (mIncomingQueued) return;
            mIncomingQueued = true;
        }
        runOnMainThread(this::appendIncoming);
    }

    /** Append everything fed so far, in the order it arrived, and redraw once. */
    private void appendIncoming() {
        final byte[] bytes;
        synchronized (mIncoming) {
            bytes = mIncoming.toByteArray();
            mIncoming.reset();
            mIncomingQueued = false;
        }
        if (bytes.length == 0) return;
        if (mEmulator == null) {
            mPendingOutput.write(bytes, 0, bytes.length);
            trimPendingOutput();
            return;
        }
        mEmulator.append(bytes, bytes.length);
        notifyScreenUpdate();
    }

    /** Tell the remote shell the new size and reflow or initialize the emulator. */
    public void updateSize(int columns, int rows, int cellWidthPixels, int cellHeightPixels) {
        if (mEmulator == null) {
            initializeEmulator(columns, rows, cellWidthPixels, cellHeightPixels);
        } else {
            mEmulator.resize(columns, rows, cellWidthPixels, cellHeightPixels);
        }
        if (mCallbacks != null) mCallbacks.onResize(columns, rows);
    }

    /** The terminal title as set through escape sequences or null if none set. */
    public String getTitle() {
        return (mEmulator == null) ? null : mEmulator.getTitle();
    }

    /**
     * Set the terminal emulator's window size and start terminal emulation.
     * Upstream started a local subprocess here; the shell this session is
     * attached to is remote, so there is nothing to start.
     *
     * @param columns The number of columns in the terminal window.
     * @param rows    The number of rows in the terminal window.
     */
    public void initializeEmulator(int columns, int rows, int cellWidthPixels, int cellHeightPixels) {
        mEmulator = new TerminalEmulator(this, columns, rows, cellWidthPixels, cellHeightPixels, mTranscriptRows, mClient);
        flushPendingOutput();
    }

    /** Whether the emulator is currently showing its alternate screen buffer. */
    public boolean isAlternateBufferActive() {
        return mEmulator != null && mEmulator.isAlternateBufferActive();
    }

    /** Write data the user typed to the remote shell. */
    @Override
    public void write(byte[] data, int offset, int count) {
        if (count <= 0) return;
        if (mCallbacks != null) mCallbacks.onInput(Arrays.copyOfRange(data, offset, offset + count));
    }

    /** Write the Unicode code point to the terminal encoded in UTF-8. */
    public void writeCodePoint(boolean prependEscape, int codePoint) {
        if (codePoint > 1114111 || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
            // 1114111 (= 2**16 + 1024**2 - 1) is the highest code point, [0xD800,0xDFFF] is the surrogate range.
            throw new IllegalArgumentException("Invalid code point: " + codePoint);
        }

        int bufferPosition = 0;
        if (prependEscape) mUtf8InputBuffer[bufferPosition++] = 27;

        if (codePoint <= /* 7 bits */0b1111111) {
            mUtf8InputBuffer[bufferPosition++] = (byte) codePoint;
        } else if (codePoint <= /* 11 bits */0b11111111111) {
            /* 110xxxxx leading byte with leading 5 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11000000 | (codePoint >> 6));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else if (codePoint <= /* 16 bits */0b1111111111111111) {
            /* 1110xxxx leading byte with leading 4 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11100000 | (codePoint >> 12));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        } else { /* We have checked codePoint <= 1114111 above, so we have max 21 bits = 0b111111111111111111111 */
            /* 11110xxx leading byte with leading 3 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b11110000 | (codePoint >> 18));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 12) & 0b111111));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | ((codePoint >> 6) & 0b111111));
            /* 10xxxxxx continuation byte with following 6 bits */
            mUtf8InputBuffer[bufferPosition++] = (byte) (0b10000000 | (codePoint & 0b111111));
        }
        write(mUtf8InputBuffer, 0, bufferPosition);
    }

    public TerminalEmulator getEmulator() {
        return mEmulator;
    }

    /** Notify the {@link #mClient} that the screen has changed. */
    protected void notifyScreenUpdate() {
        if (mClient != null) mClient.onTextChanged(this);
    }

    /** Reset state for terminal emulator state. */
    public void reset() {
        if (mEmulator != null) mEmulator.reset();
        notifyScreenUpdate();
    }

    @Override
    public void titleChanged(String oldTitle, String newTitle) {
        if (mClient != null) mClient.onTitleChanged(this);
    }

    @Override
    public void onCopyTextToClipboard(String text) {
        if (mClient != null) mClient.onCopyTextToClipboard(this, text);
    }

    @Override
    public void onPasteTextFromClipboard() {
        if (mClient != null) mClient.onPasteTextFromClipboard(this);
    }

    @Override
    public void onBell() {
        if (mClient != null) mClient.onBell(this);
    }

    @Override
    public void onColorsChanged() {
        if (mClient != null) mClient.onColorsChanged(this);
    }

    /**
     * Drop the oldest buffered output past {@link #MAX_PENDING_OUTPUT_BYTES},
     * so a flood before the view is ready cannot grow the buffer without limit.
     */
    private void trimPendingOutput() {
        int excess = mPendingOutput.size() - MAX_PENDING_OUTPUT_BYTES;
        if (excess <= 0) return;
        byte[] all = mPendingOutput.toByteArray();
        mPendingOutput.reset();
        mPendingOutput.write(all, excess, all.length - excess);
    }

    /**
     * Append output buffered before the emulator existed, in the order it
     * arrived. Called once the emulator is created, before any later feed.
     */
    private void flushPendingOutput() {
        if (mPendingOutput.size() == 0) return;
        byte[] pending = mPendingOutput.toByteArray();
        mPendingOutput.reset();
        mEmulator.append(pending, pending.length);
        notifyScreenUpdate();
    }

    /**
     * Run the action on the main thread. Where there is no main looper (a plain
     * JVM test) or the caller is already on it, the action runs inline.
     */
    private void runOnMainThread(Runnable action) {
        Looper mainLooper = Looper.getMainLooper();
        if (mainLooper == null || Looper.myLooper() == mainLooper) {
            action.run();
            return;
        }
        if (mMainThreadHandler == null) mMainThreadHandler = new Handler(mainLooper);
        mMainThreadHandler.post(action);
    }

}
