# libinjection 4.0.2

The C sources, headers and COPYING are unmodified files from the
[upstream release](https://github.com/libinjection/libinjection/releases/tag/v4.0.2),
commit `7244a1e3c633ea13b3c89d2f670da25789e152fc`. The CMake project builds
the three upstream translation units into a shared library for the HTTP guard.

From the repository root, with CMake and a C compiler installed:

```sh
cmake -S third_party/libinjection -B dist/http-guard/build -DCMAKE_BUILD_TYPE=Release
cmake --build dist/http-guard/build --config Release
cmake --install dist/http-guard/build --config Release --prefix dist/http-guard
```

Local Python processes find the library in `dist/http-guard`. The production
image installs `/usr/local/lib/libomp_injection.so`. An absolute
`OMP_LIBINJECTION_PATH` selects a different installation. The running engine
verifies the upstream version before accepting requests for inspection.
