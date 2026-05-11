"""
app.py
Obsidian Investigation Builder — main GUI.
Requires: pip install customtkinter

Run: python app.py
"""

import threading
import os
import tkinter as tk
from tkinter import filedialog
import customtkinter as ctk

from state import load_reference, save_reference, summary, all_items
from vault_writer import write_vault
from engine import run_investigation


# ── Theme ─────────────────────────────────────────────────────────────────────
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")

AMBER   = "#F59E0B"
DIM     = "#6B7280"
SUCCESS = "#34D399"
WARN    = "#F87171"
BG      = "#0F1117"
PANEL   = "#1A1D27"
BORDER  = "#2D3148"

MONO = ("Consolas", 11)
SANS = ("Segoe UI", 11)


# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_subjects(raw: str) -> list[str]:
    """Split comma or newline separated input, title-case, deduplicate."""
    items = []
    for chunk in raw.replace(",", "\n").splitlines():
        name = chunk.strip().title()
        if name and name not in items:
            items.append(name)
    return items


def _divider(parent):
    """Thin horizontal rule used as a section separator in the left panel."""
    ctk.CTkFrame(parent, height=1, fg_color=BORDER).pack(fill="x", padx=12, pady=(4, 0))


# ── Main App ──────────────────────────────────────────────────────────────────

class App(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("Obsidian Investigation Builder")
        self.geometry("980x720")
        self.minsize(820, 560)
        self.configure(fg_color=BG)

        # State
        self._reference_data: dict = {"items": {}, "connections": {}}
        self._stop_event = threading.Event()
        self._running = False

        # Paths (StringVars so labels update reactively)
        self._vault_path  = tk.StringVar(value="")
        self._ref_path    = tk.StringVar(value="")

        self._build_ui()

    # ── UI construction ───────────────────────────────────────────────────────

    def _build_ui(self):
        # ── Title bar ─────────────────────────────────────────────────────────
        title_bar = ctk.CTkFrame(self, fg_color=PANEL, height=52, corner_radius=0)
        title_bar.pack(fill="x", side="top")
        ctk.CTkLabel(
            title_bar,
            text="  ◈  OBSIDIAN INVESTIGATION BUILDER",
            font=("Consolas", 13, "bold"),
            text_color=AMBER,
        ).pack(side="left", padx=16, pady=14)

        # ── Body (left panel + log) ────────────────────────────────────────────
        body = ctk.CTkFrame(self, fg_color="transparent")
        body.pack(fill="both", expand=True, padx=14, pady=(10, 14))
        body.columnconfigure(0, weight=0, minsize=320)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)

        self._build_left(body)
        self._build_right(body)

    def _build_left(self, parent):
        left = ctk.CTkFrame(parent, fg_color=PANEL, corner_radius=10, width=320)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 10))
        left.pack_propagate(False)

        pad = {"padx": 16, "pady": (0, 12)}

        # Section: Paths
        self._section_label(left, "PATHS")

        self._path_row(left, "Vault folder",    self._vault_path,  self._browse_vault)
        self._path_row(left, "Reference file",  self._ref_path,    self._browse_ref)

        load_btn = self._small_btn(left, "↺  Load reference", self._load_reference, color=DIM)
        load_btn.pack(fill="x", **pad)

        self._ref_summary = ctk.CTkLabel(
            left, text="No reference loaded", font=("Consolas", 10),
            text_color=DIM, anchor="w", wraplength=280,
        )
        self._ref_summary.pack(fill="x", padx=16, pady=(0, 8))

        _divider(left)

        # Section: Subjects
        self._section_label(left, "SUBJECTS")

        ctk.CTkLabel(left, text="One per line, or comma-separated",
                     font=SANS, text_color=DIM, anchor="w").pack(fill="x", padx=16, pady=(0, 4))

        self._subjects_box = ctk.CTkTextbox(
            left, height=110, font=MONO,
            fg_color="#0D1117", border_color=BORDER, border_width=1,
            text_color="#E5E7EB",
        )
        self._subjects_box.pack(fill="x", padx=16, pady=(0, 12))

        ctk.CTkLabel(left, text="Context (optional)",
                     font=SANS, text_color=DIM, anchor="w").pack(fill="x", padx=16, pady=(0, 4))

        self._context_box = ctk.CTkEntry(
            left, placeholder_text="e.g. Cold War espionage investigation",
            font=SANS, fg_color="#0D1117", border_color=BORDER, border_width=1,
        )
        self._context_box.pack(fill="x", padx=16, pady=(0, 14))

        _divider(left)

        # Section: Parameters
        self._section_label(left, "PARAMETERS")

        self._depth_var = tk.IntVar(value=2)
        self._slider_row(left, "Search depth", self._depth_var, 1, 4, integer=True)

        self._threshold_var = tk.DoubleVar(value=0.6)
        self._slider_row(left, "Min connection", self._threshold_var, 0.1, 1.0, integer=False)

        self._maxhop_var = tk.IntVar(value=5)
        self._slider_row(left, "Max per hop", self._maxhop_var, 1, 10, integer=True)

        self._web_var = tk.BooleanVar(value=True)
        ctk.CTkCheckBox(
            left, text="Web search", variable=self._web_var,
            font=SANS, checkmark_color=AMBER, fg_color=AMBER, hover_color="#D97706",
        ).pack(padx=16, pady=(0, 14), anchor="w")

        _divider(left)

        # Run / Stop
        self._run_btn = ctk.CTkButton(
            left, text="▶  RUN",
            font=("Consolas", 13, "bold"),
            fg_color=AMBER, hover_color="#D97706", text_color="#0F1117",
            height=40, corner_radius=6,
            command=self._start,
        )
        self._run_btn.pack(fill="x", padx=16, pady=(12, 6))

        self._stop_btn = ctk.CTkButton(
            left, text="■  STOP",
            font=("Consolas", 12, "bold"),
            fg_color="#374151", hover_color=WARN, text_color="#E5E7EB",
            height=34, corner_radius=6,
            command=self._stop, state="disabled",
        )
        self._stop_btn.pack(fill="x", padx=16, pady=(0, 16))

    def _build_right(self, parent):
        right = ctk.CTkFrame(parent, fg_color=PANEL, corner_radius=10)
        right.grid(row=0, column=1, sticky="nsew")
        right.rowconfigure(1, weight=1)
        right.columnconfigure(0, weight=1)

        # Header row
        hdr = ctk.CTkFrame(right, fg_color="transparent")
        hdr.grid(row=0, column=0, sticky="ew", padx=14, pady=(12, 6))
        hdr.columnconfigure(0, weight=1)

        ctk.CTkLabel(hdr, text="LOG", font=("Consolas", 11, "bold"),
                     text_color=AMBER).grid(row=0, column=0, sticky="w")

        self._clear_btn = self._small_btn(hdr, "clear", self._clear_log, color=DIM)
        self._clear_btn.grid(row=0, column=1, sticky="e")

        # Log textbox
        self._log = ctk.CTkTextbox(
            right, font=MONO, fg_color="#0D1117",
            text_color="#D1D5DB", wrap="word",
            border_color=BORDER, border_width=1,
        )
        self._log.grid(row=1, column=0, sticky="nsew", padx=14, pady=(0, 10))
        self._log.configure(state="disabled")

        # Progress bar
        self._progress = ctk.CTkProgressBar(right, fg_color=BORDER, progress_color=AMBER)
        self._progress.grid(row=2, column=0, sticky="ew", padx=14, pady=(0, 6))
        self._progress.set(0)

        self._progress_label = ctk.CTkLabel(
            right, text="", font=("Consolas", 10), text_color=DIM,
        )
        self._progress_label.grid(row=3, column=0, sticky="w", padx=14, pady=(0, 10))

    # ── Reusable sub-widgets ──────────────────────────────────────────────────

    def _section_label(self, parent, text):
        ctk.CTkLabel(
            parent, text=text, font=("Consolas", 10, "bold"),
            text_color=AMBER, anchor="w",
        ).pack(fill="x", padx=16, pady=(14, 4))

    def _path_row(self, parent, label, var, command):
        row = ctk.CTkFrame(parent, fg_color="transparent")
        row.pack(fill="x", padx=16, pady=(0, 4))
        row.columnconfigure(0, weight=1)

        ctk.CTkLabel(row, text=label, font=SANS, text_color=DIM,
                     anchor="w").grid(row=0, column=0, sticky="w")
        ctk.CTkButton(
            row, text="Browse", font=SANS, width=64, height=24,
            fg_color=BORDER, hover_color="#3D4A6B", text_color="#E5E7EB",
            command=command,
        ).grid(row=0, column=1, sticky="e")

        path_label = ctk.CTkLabel(
            parent, textvariable=var, font=("Consolas", 9),
            text_color=DIM, anchor="w", wraplength=280,
        )
        path_label.pack(fill="x", padx=16, pady=(0, 6))

    def _slider_row(self, parent, label, var, from_, to, integer=False):
        row = ctk.CTkFrame(parent, fg_color="transparent")
        row.pack(fill="x", padx=16, pady=(0, 10))
        row.columnconfigure(1, weight=1)

        val_label = ctk.CTkLabel(row, text="", font=MONO, text_color="#E5E7EB", width=36)
        val_label.grid(row=0, column=2, sticky="e", padx=(6, 0))

        ctk.CTkLabel(row, text=label, font=SANS, text_color="#9CA3AF",
                     anchor="w", width=110).grid(row=0, column=0, sticky="w")

        def _update(v):
            val_label.configure(text=str(int(float(v))) if integer else f"{float(v):.2f}")
        _update(var.get())

        slider = ctk.CTkSlider(
            row, variable=var, from_=from_, to=to,
            button_color=AMBER, button_hover_color="#D97706",
            progress_color=AMBER, fg_color=BORDER,
            command=_update,
        )
        if integer:
            slider.configure(number_of_steps=int(to - from_))
        slider.grid(row=0, column=1, sticky="ew", padx=(8, 0))

    def _small_btn(self, parent, text, command, color=BORDER):
        return ctk.CTkButton(
            parent, text=text, font=("Consolas", 10),
            width=80, height=24, corner_radius=4,
            fg_color=color, hover_color="#3D4A6B", text_color="#E5E7EB",
            command=command,
        )

    # ── Browse callbacks ──────────────────────────────────────────────────────

    def _browse_vault(self):
        path = filedialog.askdirectory(title="Select Obsidian vault folder")
        if path:
            self._vault_path.set(path)
            # Auto-suggest reference file next to vault folder
            if not self._ref_path.get():
                ref = os.path.join(os.path.dirname(path), "investigation_reference.json")
                self._ref_path.set(ref)
                self._load_reference()

    def _browse_ref(self):
        path = filedialog.asksaveasfilename(
            title="Reference file location",
            defaultextension=".json",
            filetypes=[("JSON", "*.json")],
            initialfile="investigation_reference.json",
        )
        if path:
            self._ref_path.set(path)
            self._load_reference()

    # ── Reference file ────────────────────────────────────────────────────────

    def _load_reference(self):
        path = self._ref_path.get()
        if not path:
            self._log_write("⚠ Set a reference file path first.")
            return
        self._reference_data = load_reference(path)
        text = summary(self._reference_data)
        self._ref_summary.configure(text=text)
        self._log_write(f"↺ Reference loaded: {text}")

    # ── Log helpers ───────────────────────────────────────────────────────────

    def _log_write(self, text: str):
        """Append a line to the log. Thread-safe via after()."""
        def _do():
            self._log.configure(state="normal")
            self._log.insert("end", text + "\n")
            self._log.see("end")
            self._log.configure(state="disabled")
        self.after(0, _do)

    def _clear_log(self):
        self._log.configure(state="normal")
        self._log.delete("1.0", "end")
        self._log.configure(state="disabled")

    def _set_progress(self, current: int, total: int):
        """Update progress bar. Thread-safe via after()."""
        def _do():
            if total == 0:
                self._progress.set(0)
                self._progress_label.configure(text="")
            else:
                self._progress.set(current / total)
                self._progress_label.configure(text=f"Scoring pairs: {current} / {total}")
        self.after(0, _do)

    # ── Run / Stop ────────────────────────────────────────────────────────────

    def _start(self):
        if self._running:
            return

        # Validate inputs
        subjects_raw = self._subjects_box.get("1.0", "end")
        seeds = parse_subjects(subjects_raw)
        if not seeds:
            self._log_write("⚠ Enter at least one subject.")
            return

        vault  = self._vault_path.get().strip()
        ref    = self._ref_path.get().strip()
        if not vault:
            self._log_write("⚠ Set a vault output folder.")
            return
        if not ref:
            self._log_write("⚠ Set a reference file path.")
            return

        depth     = int(self._depth_var.get())
        threshold = round(float(self._threshold_var.get()), 2)
        max_hop   = int(self._maxhop_var.get())
        use_web   = self._web_var.get()
        context   = self._context_box.get().strip()

        # Ensure reference is loaded
        if not self._reference_data["items"] and os.path.exists(ref):
            self._load_reference()

        self._running = True
        self._stop_event.clear()
        self._run_btn.configure(state="disabled", fg_color=DIM)
        self._stop_btn.configure(state="normal")

        self._log_write(f"\n▶ Starting investigation")
        self._log_write(f"  Seeds: {', '.join(seeds)}")
        self._log_write(f"  Depth: {depth}  |  Threshold: {threshold}  |  Max/hop: {max_hop}")
        if context:
            self._log_write(f"  Context: {context}")

        thread = threading.Thread(target=self._run_thread, args=(
            seeds, depth, threshold, max_hop, use_web, context, vault, ref,
        ), daemon=True)
        thread.start()

    def _stop(self):
        self._stop_event.set()
        self._log_write("⚠ Stop requested...")

    def _run_thread(self, seeds, depth, threshold, max_hop, use_web, context, vault, ref):
        try:
            updated = run_investigation(
                seeds=seeds,
                depth=depth,
                threshold=threshold,
                max_per_hop=max_hop,
                use_web=use_web,
                context=context,
                reference_data=self._reference_data,
                log=self._log_write,
                set_progress=self._set_progress,
                stop_event=self._stop_event,
            )

            # Save reference
            self._log_write(f"\n💾 Saving reference → {ref}")
            save_reference(ref, updated)
            self._reference_data = updated

            # Update summary label
            text = summary(updated)
            self.after(0, lambda: self._ref_summary.configure(text=text))

            # Write vault
            self._log_write(f"📂 Writing Obsidian files → {vault}")
            written = write_vault(vault, updated, min_score=threshold)
            self._log_write(f"   Wrote {len(written)} file(s).")

        except Exception as e:
            self._log_write(f"\n✕ Error: {e}")
            raise
        finally:
            self.after(0, self._on_run_complete)

    def _on_run_complete(self):
        self._running = False
        self._run_btn.configure(state="normal", fg_color=AMBER)
        self._stop_btn.configure(state="disabled")
        self._set_progress(0, 0)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = App()
    app.mainloop()
