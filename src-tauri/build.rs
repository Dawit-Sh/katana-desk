fn main() {
    build_djvulibre();
    tauri_build::build()
}

/// DjVuLibre's libdjvu (vendored in djvu/djvulibre, see its KATANA.md) and Katana's C glue
/// (djvu/katana_djvu.cpp), built from source with the platform's C++ compiler: MSVC on Windows,
/// g++ or clang++ on Linux and macOS. The list is `libdjvulibre_la_SOURCES` from DjVuLibre 3.5.28's
/// libdjvu/Makefile.am, as in Katana's Android CMakeLists.txt.
fn build_djvulibre() {
    const SOURCES: &[&str] = &[
        "Arrays", "BSByteStream", "BSEncodeByteStream", "ByteStream", "DataPool", "DjVmDir", "DjVmDir0", "DjVmDoc",
        "DjVmNav", "DjVuAnno", "DjVuDocEditor", "DjVuDocument", "DjVuDumpHelper", "DjVuErrorList", "DjVuFile",
        "DjVuFileCache", "DjVuGlobal", "DjVuGlobalMemory", "DjVuImage", "DjVuInfo", "DjVuMessage", "DjVuMessageLite",
        "DjVuNavDir", "DjVuPalette", "DjVuPort", "DjVuText", "DjVuToPS", "GBitmap", "GContainer", "GException",
        "GIFFManager", "GMapAreas", "GOS", "GPixmap", "GRect", "GScaler", "GSmartPointer", "GString", "GThreads",
        "GURL", "GUnicode", "IFFByteStream", "IW44EncodeCodec", "IW44Image", "JB2EncodeCodec", "JB2Image",
        "JPEGDecoder", "MMRDecoder", "MMX", "UnicodeByteStream", "XMLParser", "XMLTags", "ZPCodec", "atomic",
        "ddjvuapi", "debug", "miniexp",
    ];
    println!("cargo:rerun-if-changed=djvu");
    let mut b = cc::Build::new();
    b.cpp(true)
        .include("djvu")
        .include("djvu/djvulibre")
        .define("HAVE_CONFIG_H", None)
        // linked statically: no DLL import or export markers
        .define("DJVUAPI", Some(""))
        .define("DDJVUAPI", Some(""))
        .define("MINILISPAPI", Some(""))
        .file("djvu/katana_djvu.cpp")
        .warnings(false);
    for s in SOURCES {
        b.file(format!("djvu/djvulibre/{s}.cpp"));
    }
    let msvc = b.get_compiler().is_like_msvc();
    if msvc {
        // C++14 is MSVC's lowest; exceptions on, UTF-8 sources
        b.flag("/std:c++14").flag("/EHsc").flag("/utf-8").flag("/w");
    } else {
        // DjVuLibre predates C++17 (GBitmap.h still uses `register`)
        b.flag("-std=gnu++14").flag("-fexceptions").flag("-w");
    }
    b.compile("katana_djvu");
    if !msvc {
        // DjVuLibre decodes on its own threads
        println!("cargo:rustc-link-lib=pthread");
    }
}
