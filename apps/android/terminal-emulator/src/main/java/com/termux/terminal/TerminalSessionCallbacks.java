package com.termux.terminal;

/**
 * The callbacks a {@link TerminalSession} uses to reach the shell it is
 * attached to. Upstream wired these to a local pseudoterminal process through
 * JNI; here the shell runs on a remote bridge, so these are how it receives
 * the user's input and learns the terminal's size.
 */
public interface TerminalSessionCallbacks {

    /**
     * Called with the bytes the user produced: key events, IME text and
     * pastes, already encoded as UTF-8 where they came from a code point.
     */
    void onInput(byte[] data);

    /**
     * Called when the terminal's size changes, so the remote shell can be told
     * its new dimensions (and, on the first call, before any output arrives).
     */
    void onResize(int columns, int rows);

}
