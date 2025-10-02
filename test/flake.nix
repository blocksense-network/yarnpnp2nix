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
            preInstallScript = "export npm_config_nodedir=${pkgs.nodejs}";
            buildInputs = with pkgs; ([
              autoconf zlib gcc automake pkg-config libtool file
              python3
              pixman cairo pango libpng libjpeg giflib librsvg libwebp libuuid
            ] ++ (if pkgs.stdenv.isDarwin then [ darwin.apple_sdk.frameworks.CoreText ] else []));
          };
          "sharp@npm:0.31.1" = {
            preInstallScript = "export npm_config_nodedir=${pkgs.nodejs}";
            buildInputs = with pkgs; [pkg-config vips nodejs.python];
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
          sharp = yarnPackages."sharp@npm:0.31.1";
          canvas = yarnPackages."canvas@npm:2.10.1";
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
          ] ++ packageOverrides."canvas@npm:2.10.1".buildInputs;

          # inputsFrom = builtins.filter (p: p.shouldBeUnplugged or false) allYarnPackages;

          shellHook = ''
            export LD_LIBRARY_PATH=${pkgs.lib.makeLibraryPath [pkgs.libuuid]}
            export YARN_PLUGINS=${pkgs.yarn-plugin-yarnpnp2nix}/plugin.js
          '';
        };
      };
    };
}
