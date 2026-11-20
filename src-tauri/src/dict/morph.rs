//! Headwords an English word form might come from, for when a dictionary doesn't list the form itself:
//! WordNet's detachment rules ("morphy") plus doubled consonants (running -> run, bigger -> big) and
//! possessives. Only candidates: a dictionary keeps the one it has.

/// The word as a dictionary key: lowercase, straight apostrophes, no punctuation around it.
pub fn key_of(word: &str) -> String {
    let w = word
        .trim()
        .replace(['\u{2019}', '\u{2018}', '\u{02bc}'], "'")
        .replace('\u{00ad}', "")
        .to_lowercase();
    let w = w.trim_matches(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '-' || c == '.'));
    let w = w.trim_matches(|c: char| c == '\'' || c == '-');
    // a full stop at the end is the sentence's, unless the word has dots inside ("e.g.")
    let w = if w.ends_with('.') && !w[..w.len() - 1].contains('.') { w.trim_end_matches('.') } else { w };
    w.trim_start_matches('.').to_string()
}

const SUFFIXES: &[(&str, &str)] = &[
    // nouns
    ("ses", "s"),
    ("xes", "x"),
    ("zes", "z"),
    ("ches", "ch"),
    ("shes", "sh"),
    ("men", "man"),
    ("ies", "y"),
    ("ves", "f"),
    ("ves", "fe"),
    ("s", ""),
    // verbs
    ("es", "e"),
    ("es", ""),
    ("ied", "y"),
    ("ed", "e"),
    ("ed", ""),
    ("ying", "ie"),
    ("ing", "e"),
    ("ing", ""),
    // adjectives
    ("ier", "y"),
    ("iest", "y"),
    ("er", ""),
    ("est", ""),
    ("er", "e"),
    ("est", "e"),
    // adverbs, last: "quickly" is better shown as "quick" than not at all
    ("ily", "y"),
    ("ly", ""),
];

/// Candidate headwords for `key` (already a key), most likely first, never `key` itself.
pub fn candidates(key: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if s.len() > 1 && s != key && !out.contains(&s) {
            out.push(s);
        }
    };
    // possessives: "Scrooge's", "clerks'"
    if let Some(s) = key.strip_suffix("'s") {
        push(s.to_string());
    }
    if let Some(s) = key.strip_suffix('\'') {
        push(s.to_string());
    }
    for (suf, rep) in SUFFIXES {
        if let Some(stem) = key.strip_suffix(suf) {
            if stem.is_empty() || stem.chars().count() + rep.len() < 2 {
                continue;
            }
            push(format!("{stem}{rep}"));
            // stopped -> stop, running -> run, bigger -> big
            if rep.is_empty() && matches!(*suf, "ed" | "ing" | "er" | "est") {
                let cs: Vec<char> = stem.chars().collect();
                let n = cs.len();
                if n >= 3 && cs[n - 1] == cs[n - 2] && !"aeiouslz".contains(cs[n - 1]) {
                    push(cs[..n - 1].iter().collect());
                }
            }
        }
    }
    // hyphenated and spaced phrases: also the word without hyphens
    if key.contains('-') {
        push(key.replace('-', " "));
        push(key.replace('-', ""));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_plain() {
        assert_eq!(key_of("“Ironmongery,”"), "ironmongery");
        assert_eq!(key_of("Scrooge’s"), "scrooge's");
        assert_eq!(key_of("door-nail."), "door-nail");
        assert_eq!(key_of("  Covetous! "), "covetous");
        assert_eq!(key_of("e.g."), "e.g.");
    }

    #[test]
    fn forms_find_their_headword() {
        let has = |w: &str, l: &str| candidates(w).contains(&l.to_string());
        assert!(has("running", "run"));
        assert!(has("stopped", "stop"));
        assert!(has("bigger", "big"));
        assert!(has("wolves", "wolf"));
        assert!(has("knives", "knife"));
        assert!(has("studies", "study"));
        assert!(has("clutching", "clutch"));
        assert!(has("hoped", "hope"));
        assert!(has("dying", "die"));
        assert!(has("scrooge's", "scrooge"));
        assert!(has("dog-days", "dog days"));
        assert!(!candidates("run").contains(&"run".to_string()));
    }
}
