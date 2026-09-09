# Keep the reviewed host and ARM compiler versions reproducible in CI.
let
  pkgs = import (builtins.getFlake "github:NixOS/nixpkgs/b756cdf503c3dfe648f073c0407ab1facfd40ea2").outPath { };
  arm = pkgs.gcc-arm-embedded.overrideAttrs (_: {
    version = "13.3.rel1";
    src = pkgs.fetchurl {
      url = "https://developer.arm.com/-/media/Files/downloads/gnu/13.3.rel1/binrel/arm-gnu-toolchain-13.3.rel1-x86_64-arm-none-eabi.tar.xz";
      hash = "sha256-lcARzuQw5k3WCHx1yADwS5xJgyzBAAEnqSqX+cjYOvQ=";
    };
  });
  cryptoc = builtins.fetchGit {
    url = "https://chromium.googlesource.com/chromiumos/third_party/cryptoc";
    ref = "refs/heads/main";
    rev = "0dd679081b9c8bfa2583d74e3a17a413709ea362";
  };
in
pkgs.mkShell {
  packages = with pkgs; [ arm gcc13 gnumake python3 pkg-config ncurses openssl git ];
  shellHook = ''
    export CROSS_COMPILE=${arm}/bin/arm-none-eabi-
    export CRYPTOC_DIR=${cryptoc}
  '';
}
