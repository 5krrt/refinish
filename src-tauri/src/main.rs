// Hides the console window on Windows release builds — without this you'd
// get a cmd.exe flash every time the app launches. Do not remove.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    refinish_lib::run()
}
