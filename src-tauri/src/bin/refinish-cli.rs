// Command-line front door to Refinish's encoder, for scripts that need compression
// without the app (e.g. gridfolio's studio-publish.py squeezing oversized uploads).
//
//   refinish-cli jpeg <input> <output> [--quality 1-100]
//
// Writes a compressed copy to <output> and prints its size in bytes. The input file is
// never modified. Exits non-zero with a message on stderr if anything goes wrong.

use std::path::PathBuf;
use std::process::ExitCode;

const DEFAULT_QUALITY: u8 = 90;

fn usage() -> ExitCode {
    eprintln!("usage: refinish-cli jpeg <input> <output> [--quality 1-100]");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 || args[0] != "jpeg" {
        return usage();
    }

    let input = PathBuf::from(&args[1]);
    let output = PathBuf::from(&args[2]);
    let mut quality = DEFAULT_QUALITY;

    let mut rest = args[3..].iter();
    while let Some(flag) = rest.next() {
        match (flag.as_str(), rest.next()) {
            ("--quality", Some(v)) => match v.parse::<u8>() {
                Ok(q) if (1..=100).contains(&q) => quality = q,
                _ => return usage(),
            },
            _ => return usage(),
        }
    }

    if input == output {
        eprintln!("refinish-cli: output must be a different file than the input");
        return ExitCode::from(2);
    }

    match refinish_lib::compress_jpeg_to(&input, &output, quality) {
        Ok(bytes) => {
            println!("{}", bytes);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("refinish-cli: {}", e);
            ExitCode::FAILURE
        }
    }
}
