{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";
    utils.url = "github:gytis-ivaskevicius/flake-utils-plus";
    yarnpnp2nix.url = "../.";
    yarnpnp2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ self, nixpkgs, utils, yarnpnp2nix }:
    utils.lib.mkFlake {
      inherit self inputs;
      sharedOverlays = [ yarnpnp2nix.overlays.default ];
      outputsBuilder = channels:
      let
        inherit (nixpkgs) lib;
        pkgs = channels.nixpkgs;
        mkYarnPackagesFromManifest = yarnpnp2nix.lib."${pkgs.stdenv.system}".mkYarnPackagesFromManifest;
        yarnPackages = mkYarnPackagesFromManifest {
          yarnManifest = import ./workspace/yarn-manifest.nix;
          inherit packageOverrides;
        };
        packageOverrides = {
          "canvas@npm:2.10.1" = {
            # Let node-gyp find node headers
            # see:
            # - https://github.com/NixOS/nixpkgs/issues/195404
            # - https://github.com/NixOS/nixpkgs/pull/201715#issuecomment-1326799041
            # note that:
            #   npm config set nodedir ${pkgs.nodejs}
            # yields:
            #   npm ERR! `nodedir` is not a valid npm option
            # so we use the env var as described in:
            #   https://github.com/nodejs/node-gyp#environment-variables
            preInstallScript = ''
              export PATH=${pkgs.python311}/bin:$PATH
              export npm_config_nodedir=${pkgs.nodejs}
              export npm_config_python=${lib.getExe pkgs.python311}
              export PYTHON=${lib.getExe pkgs.python311}
            '';
            buildInputs = with pkgs; ([
              autoconf zlib gcc automake pkg-config libtool file
              python311
              pixman cairo pango libpng libjpeg giflib librsvg libwebp libuuid
            ] ++ (if pkgs.stdenv.isDarwin then [ darwin.apple_sdk.frameworks.CoreText ] else []));
            # Build against default Node (Node 22), using Python 3.11 for node-gyp
          };
          "canvas@npm:2.11.2" = {
            # Build against Node 22 with Python 3.11 for node-gyp
            preInstallScript = ''
              export PATH=${pkgs.python311}/bin:$PATH
              export npm_config_nodedir=${pkgs.nodejs}
              export npm_config_python=${lib.getExe pkgs.python311}
              export PYTHON=${lib.getExe pkgs.python311}
            '';
            buildInputs = with pkgs; ([
              autoconf zlib gcc automake pkg-config libtool file
              python311
              pixman cairo pango libpng libjpeg giflib librsvg libwebp libuuid
            ] ++ (if pkgs.stdenv.isDarwin then [ darwin.apple_sdk.frameworks.CoreText ] else []));
          };
          "testa@workspace:packages/testa" = {
            filterDependencies = dep: dep != "color" && dep != "testf";
            build = ''
              echo $PATH
              tsc --version
              tsc
            '';
          };
          "testb@workspace:packages/testb" = {
            build = ''
              LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath [pkgs.libuuid]} node build
              node build
              webpack --version
            '';
          };
          "anymatch@npm:3.1.2" = {
            shouldBeUnplugged = true;
          };
          "sharp@npm:0.31.3" = {
            shouldBeUnplugged = true;
            # Sharp needs to be built from source in Nix environment
            # as it can't download prebuilt binaries in sandboxed build
            preInstallScript = ''
              export npm_config_sharp_binary_host=OFF
              export npm_config_sharp_libvips_binary_host=OFF
              export npm_config_build_from_source=true
              export npm_config_nodedir=${pkgs.nodejs}
              export PATH=${pkgs.python311}/bin:$PATH
              export npm_config_python=${lib.getExe pkgs.python311}
              export PYTHON=${lib.getExe pkgs.python311}
            '';
            buildInputs = with pkgs; [
              autoconf automake gcc pkg-config libtool file
              python311 vips glib
            ] ++ (if pkgs.stdenv.isDarwin then [ darwin.apple_sdk.frameworks.CoreText ] else []);
          };
        };
        allYarnPackages = builtins.attrValues yarnPackages;

        packages = {
          inherit pkgs yarnPackages;
          yarn-plugin = yarnpnp2nix.packages."${pkgs.stdenv.system}".yarn-plugin;
          react = yarnPackages."react@npm:18.2.0";
          esbuild = yarnPackages."esbuild@npm:0.15.10";
          testa = yarnPackages."testa@workspace:packages/testa";
          testb = yarnPackages."testb@workspace:packages/testb";
          teste = yarnPackages."teste@workspace:packages/teste";
          canvas = yarnPackages."canvas@npm:2.11.2";
          open = yarnPackages."open@patch:open@npm%3A8.4.0#.yarn/patches/open-npm-8.4.0-df63cfe537::version=8.4.0&hash=caabd2&locator=root-workspace-0b6124%40workspace%3A.";
          test-tgz = yarnPackages."test-tgz-redux-saga-core@file:../../localPackageTests/test-tgz-redux-saga-core.tgz#../../localPackageTests/test-tgz-redux-saga-core.tgz::hash=b2ff7c&locator=testb%40workspace%3Apackages%2Ftestb";
        };
      in {
        inherit packages;
        images = {
          testa = pkgs.dockerTools.streamLayeredImage {
            name = "testa";
            maxLayers = 1000;
            config.Cmd = "${packages.testa}/bin/testa-test";
          };
          testb = pkgs.dockerTools.streamLayeredImage {
            name = "testb";
            maxLayers = 1000;
            config.Cmd = "${packages.testb}/bin/testb";
          };
        };
        devShell = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            yarnBerry
          ] ++ packageOverrides."canvas@npm:2.11.2".buildInputs;

          # inputsFrom = builtins.filter (p: p.shouldBeUnplugged or false) allYarnPackages;

          shellHook = ''
            export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath [pkgs.libuuid]}
            export YARN_PLUGINS=${pkgs.yarn-plugin-yarnpnp2nix}/plugin.js
          '';
        };
      };
    };
}
