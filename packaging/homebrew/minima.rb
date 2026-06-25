class Minima < Formula
  include Language::Python::Virtualenv

  desc "Minima CLI: cost-aware LLM model-routing coding agent"
  homepage "https://docs.minima.sh"
  url "https://github.com/mubit-ai/minima/releases/download/v0.4.3/minima_cli-0.4.3.tar.gz"
  sha256 "1faba8f372469879ad026924c241f14f6ea521e91c5f954f005fb7ab16c1ef10"
  license "FSL-1.1-Apache-2.0"

  depends_on "python@3.13"

  # Apple Silicon macOS and Linux (x86_64 / aarch64) install EVERY dependency from a prebuilt
  # wheel — no Rust/C toolchain, no source builds (install drops from ~5 min to seconds). Only
  # macOS Intel lacks a published cryptography wheel for this version, so the Rust + OpenSSL
  # build deps are scoped to that one branch (where cryptography still builds from source).
  on_macos do
    on_intel do
      depends_on "rust" => :build
      depends_on "openssl@3"
    end
  end

  # jiter / pydantic-core wheels ship `.so` modules with `@rpath` dylib IDs and no header
  # padding, so Homebrew's relocation pass fails on them — preserve_rpath skips it.
  preserve_rpath

  resource "annotated-types" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/78/b6/6307fbef88d9b5ee7421e68d78a9f162e0da4900bc5f5793f6d3d0e34fb8/annotated_types-0.7.0-py3-none-any.whl"
    sha256 "1f02e8b43a8fbbc3f3e0d4f0f4bfc8131bcb4eebe8849b8e5c773f3a1c582a53"
  end
  resource "anthropic" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/f1/bb/09e82a81885d787f350fb55ca9df865b63140dd28b3b5b3104c4ae261657/anthropic-0.111.0-py3-none-any.whl"
    sha256 "c14edb36ed80da9099acbd26b5cec810d76606c31f32a0d56a4cf9d4fa9e25ae"
  end
  resource "anyio" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/ba/16/9826f089383c593cdfc4a6e5aca94d9e91ae1692c57af82c3b2aa5e810f7/anyio-4.14.0-py3-none-any.whl"
    sha256 "dd9b7a2a9799ed6552fde617b2c5df02b7fdd7d88392fc48101e51bae46164d9"
  end
  resource "certifi" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/ef/2f/c5464532e965badff2f4c4c1a3a83f5697f0d7c407ed0cda44aaa99bb451/certifi-2026.6.17-py3-none-any.whl"
    sha256 "2227dcbaafe0d2f59279d1762ddddc37783ed4354594f194ffc31d20f41fc3db"
  end
  resource "cffi" do  # wheel (compiled)
    on_arm do
      on_macos do
        url "https://files.pythonhosted.org/packages/4a/d2/a6c0296814556c68ee32009d9c2ad4f85f2707cdecfd7727951ec228005d/cffi-2.0.0-cp313-cp313-macosx_11_0_arm64.whl"
        sha256 "45d5e886156860dc35862657e1494b9bae8dfa63bf56796f2fb56e1679fc0bca"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/a9/f5/a2c23eb03b61a0b8747f211eb716446c826ad66818ddc7810cc2cc19b3f2/cffi-2.0.0-cp313-cp313-manylinux2014_aarch64.manylinux_2_17_aarch64.whl"
        sha256 "d48a880098c96020b02d5a1f7d9251308510ce8858940e6fa99ece33f610838b"
      end
    end
    on_intel do
      on_macos do
        url "https://files.pythonhosted.org/packages/4b/8d/a0a47a0c9e413a658623d014e91e74a50cdd2c423f7ccfd44086ef767f90/cffi-2.0.0-cp313-cp313-macosx_10_13_x86_64.whl"
        sha256 "00bdf7acc5f795150faa6957054fbbca2439db2f775ce831222b66f192f03beb"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/98/df/0a1755e750013a2081e863e7cd37e0cdd02664372c754e5560099eb7aa44/cffi-2.0.0-cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"
        sha256 "c8d3b5532fc71b7a77c09192b4a5a200ea992702734a2e9279a37f2478236f26"
      end
    end
  end
  resource "charset-normalizer" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/db/8f/61959034484a4a7c527811f4721e75d02d653a35afb0b6054474d8185d4c/charset_normalizer-3.4.7-py3-none-any.whl"
    sha256 "3dce51d0f5e7951f8bb4900c257dad282f49190fdbebecd4ba99bcc41fef404d"
  end
  resource "cryptography" do  # wheel (compiled)
    on_arm do
      on_macos do
        url "https://files.pythonhosted.org/packages/9b/22/adf66990e63584a68dfb50c24f48a125c07b1699899381c8151e63ed458c/cryptography-49.0.0-cp311-abi3-macosx_11_0_arm64.whl"
        sha256 "966fe0e9c67490071f14c0d2b1cb2dfb3023c5ce39457343931415f08382f2db"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/09/41/3797cfaf69cae04a13ee78ebd83f0678d9c02b4779d21ce24445326f1a69/cryptography-49.0.0-cp311-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.whl"
        sha256 "36d1709f992593689b45bda411498d62c6e365f2ca00b84657d4dadd24de16db"
      end
    end
    on_intel do
      on_macos do
        url "https://files.pythonhosted.org/packages/1f/99/d1c90d6041656cc6ee229dc99cd67fd0cd5aec3c5f7d72fffc27cc750054/cryptography-49.0.0.tar.gz"
        sha256 "f89660a348f4f78a92366240a61404e337586ef7f5909a2fef59ca88ef505493"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/e6/8b/43011f7ebe515a8aa20d61f290a326cd890c2e738e16e59eaff8d9c3a412/cryptography-49.0.0-cp311-abi3-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"
        sha256 "0e959b578856a3924bc0cbb710fc12c387b9412a951389f3ca61704a9e25f325"
      end
    end
  end
  resource "distro" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/12/b3/231ffd4ab1fc9d679809f356cebee130ac7daa00d6d6f3206dd4fd137e9e/distro-1.9.0-py3-none-any.whl"
    sha256 "7bffd925d65168f85027d8da9af6bddab658135b840670a223589bc0c8ef02b2"
  end
  resource "docstring_parser" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/a7/5f/ed01f9a3cdffbd5a008556fc7b2a08ddb1cc6ace7effa7340604b1d16699/docstring_parser-0.18.0-py3-none-any.whl"
    sha256 "b3fcbed555c47d8479be0796ef7e19c2670d428d72e96da63f3a40122860374b"
  end
  resource "google-auth" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/44/71/c0321dc6d63d99946da45f7c06299b934e4f7f7da5c4f14d101bcb39adf1/google_auth-2.55.0-py3-none-any.whl"
    sha256 "a17cef9dedf98c4ebae2fb0c48c8f75952c877cbc2efe09f329ef16c2783d88a"
  end
  resource "google-genai" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/e0/39/00bcfd94de255d24249401efff4f48d77bf6066b46447e519fa193c0c299/google_genai-2.10.0-py3-none-any.whl"
    sha256 "d5350311567ae660c24cbc1752aee4b3d660f89c0106d2dcd2a69978c35afe1e"
  end
  resource "grpcio" do  # wheel (compiled)
    on_arm do
      on_macos do
        url "https://files.pythonhosted.org/packages/7b/4a/a36e03210183a8a7d4c80c3936acee679f4bd77d5861f369db47b2cc5f05/grpcio-1.81.1-cp313-cp313-macosx_11_0_universal2.whl"
        sha256 "819edbdcb42ab8598b494bcf0222684bbb7a3c772bd1b1f0be7e029a6063c28e"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/b0/d5/d68e30b29098f63beab6fe501100fe82674ff142b32c672532da86a99b3a/grpcio-1.81.1-cp313-cp313-manylinux2014_aarch64.manylinux_2_17_aarch64.whl"
        sha256 "c5bf2dc311127d91230cc79b92188c082634a06cf66c5234db49a43b910183b0"
      end
    end
    on_intel do
      on_macos do
        url "https://files.pythonhosted.org/packages/7b/4a/a36e03210183a8a7d4c80c3936acee679f4bd77d5861f369db47b2cc5f05/grpcio-1.81.1-cp313-cp313-macosx_11_0_universal2.whl"
        sha256 "819edbdcb42ab8598b494bcf0222684bbb7a3c772bd1b1f0be7e029a6063c28e"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/0d/1e/b47957057e729adc6cdf519a47f8be2562b7140e280f1418443eb4022192/grpcio-1.81.1-cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.whl"
        sha256 "e64dd101d380a115cc5a0c7856788adb535f1a4e21fc543775602f8be95180ae"
      end
    end
  end
  resource "h11" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/04/4b/29cac41a4d98d144bf5f6d33995617b185d14b22401f75ca86f384e87ff1/h11-0.16.0-py3-none-any.whl"
    sha256 "63cf8bbe7522de3bf65932fda1d9c2772064ffb3dae62d55932da54b31cb6c86"
  end
  resource "httpcore" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/7e/f5/f66802a942d491edb555dd61e3a9961140fd64c90bce1eafd741609d334d/httpcore-1.0.9-py3-none-any.whl"
    sha256 "2d400746a40668fc9dec9810239072b40b4484b640a8c38fd654a024c7a1bf55"
  end
  resource "httpx" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/2a/39/e50c7c3a983047577ee07d2a9e53faf5a69493943ec3f6a384bdc792deb2/httpx-0.28.1-py3-none-any.whl"
    sha256 "d909fcccc110f8c7faf814ca82a9a4d816bc5a6dbfea25d6591d6985b8ba59ad"
  end
  resource "idna" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/1e/5e/d4e9f1a599fb8e573b7b87160658329fbf28d19eac2718f51fc3def3aa5a/idna-3.18-py3-none-any.whl"
    sha256 "7f952cbe720b688055e3f87de14f5c3e5fdaa8bc3928985c4077ca689de849a2"
  end
  resource "jaraco.classes" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/7f/66/b15ce62552d84bbfcec9a4873ab79d993a1dd4edb922cbfccae192bd5b5f/jaraco.classes-3.4.0-py3-none-any.whl"
    sha256 "f662826b6bed8cace05e7ff873ce0f9283b5c924470fe664fff1c2f00f581790"
  end
  resource "jaraco.context" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/f2/58/bc8954bda5fcda97bd7c19be11b85f91973d67a706ed4a3aec33e7de22db/jaraco_context-6.1.2-py3-none-any.whl"
    sha256 "bf8150b79a2d5d91ae48629d8b427a8f7ba0e1097dd6202a9059f29a36379535"
  end
  resource "jaraco.functools" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/96/9a/982e48afcffcd727a9144506720ffd4224b6b7e355c98641866f38b7c043/jaraco_functools-4.5.0-py3-none-any.whl"
    sha256 "79ce39246eddbde4b3a03b77ea5f0f7878dc669b166a66cf3fa8e266aa3fa2f4"
  end
  resource "jiter" do  # wheel (compiled)
    on_arm do
      on_macos do
        url "https://files.pythonhosted.org/packages/86/59/db537c0949e83668c38481d426b9f2fd5ab758c4ee53a811dd0a510626a0/jiter-0.15.0-cp313-cp313-macosx_11_0_arm64.whl"
        sha256 "d1e7b1776f0797956c509e123d0952d10d293a9492dea9f288ab9570ec01d1a5"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/37/38/ea0e13b18c30ef951da0d47d39e7fa9edb82a93a62990ffbd7cea9b622d4/jiter-0.15.0-cp313-cp313-manylinux_2_17_aarch64.manylinux2014_aarch64.whl"
        sha256 "351a341c2105aa430b7047e30f1bf7975f6313b00165d3fc07be2edaf741f279"
      end
    end
    on_intel do
      on_macos do
        url "https://files.pythonhosted.org/packages/e5/f4/f708c900ecee41b2025ef8413d5351e5649eb2125c506f6720cc69b06f5c/jiter-0.15.0-cp313-cp313-macosx_10_12_x86_64.whl"
        sha256 "1c11465f97e2abf45a014b83b730222f8f1c5335e802c7055a67d50de6f1f4e3"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/8f/7c/89fbcabb2739b7a5b8dc959a1b6c5761f6484f5fed3486854b3c789bb1de/jiter-0.15.0-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
        sha256 "d1aa62e277fc1cbd80e6deacae6f4d983b41b3d7728e0645c5d741a6149bba45"
      end
    end
  end
  resource "keyring" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/81/db/e655086b7f3a705df045bf0933bdd9c2f79bb3c97bfef1384598bb79a217/keyring-25.7.0-py3-none-any.whl"
    sha256 "be4a0b195f149690c166e850609a477c532ddbfbaed96a404d4e43f8d5e2689f"
  end
  resource "linkify-it-py" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/b4/de/88b3be5c31b22333b3ca2f6ff1de4e863d8fe45aaea7485f591970ec1d3e/linkify_it_py-2.1.0-py3-none-any.whl"
    sha256 "0d252c1594ecba2ecedc444053db5d3a9b7ec1b0dd929c8f1d74dce89f86c05e"
  end
  resource "markdown-it-py" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/b3/81/4da04ced5a082363ecfa159c010d200ecbd959ae410c10c0264a38cac0f5/markdown_it_py-4.2.0-py3-none-any.whl"
    sha256 "9f7ebbcd14fe59494226453aed97c1070d83f8d24b6fc3a3bcf9a38092641c4a"
  end
  resource "mdit-py-plugins" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/a5/69/6da5581c6a7fede7dc261bf4e67d6adca4196f176b43288b55b3db395b6e/mdit_py_plugins-0.6.1-py3-none-any.whl"
    sha256 "214c82fb2ac524472ab6a5bcab1de80f73b50443e187f401bfd77efbc7c6481d"
  end
  resource "mdurl" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/b3/38/89ba8ad64ae25be8de66a6d463314cf1eb366222074cfda9ee839c56a4b4/mdurl-0.1.2-py3-none-any.whl"
    sha256 "84008a41e51615a49fc9966191ff91509e3c40b939176e643fd50a5c2196b8f8"
  end
  resource "more-itertools" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/e8/3d/1087453384dbde46a8c7f9356eead2c58be8a7bf156bca40243377c85715/more_itertools-11.1.0-py3-none-any.whl"
    sha256 "4b65538ae22f6fed0ce4874efd317463a7489796a0939fa66824dd542125a192"
  end
  resource "mubit-sdk" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/fa/e3/abfa5afd066fed654598210170ecbb70e8bfbd25ddb3e5211afa96f56b7e/mubit_sdk-0.10.0-py3-none-any.whl"
    sha256 "69778ea8456a2d9efbff8bb73d69b7fa524d9871d17202db06c50919272485f3"
  end
  resource "platformdirs" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/81/e6/cd9575ac904136b3cbf7aa7ee819ef86eedb7274e46f230e94ea4342e729/platformdirs-4.10.0-py3-none-any.whl"
    sha256 "fb516cdb12eb0d857d0cd85a7c57cea4d060bee4578d6cf5a14dfdf8cbf8784a"
  end
  resource "protobuf" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/19/c7/5f7c636ec43e0c545e28d1f1db71990108306f7bdcb89f069ba97e428e7f/protobuf-7.35.1-py3-none-any.whl"
    sha256 "4bc97768d8fe4ad6743c8a19403e314511ed9f6d13205b687e52421c023ac1b9"
  end
  resource "pyasn1" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/5d/a0/7d793dce3fa811fe047d6ae2431c672364b462850c6235ae306c0efd025f/pyasn1-0.6.3-py3-none-any.whl"
    sha256 "a80184d120f0864a52a073acc6fc642847d0be408e7c7252f31390c0f4eadcde"
  end
  resource "pyasn1-modules" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/47/8d/d529b5d697919ba8c11ad626e835d4039be708a35b0d22de83a269a6682c/pyasn1_modules-0.4.2-py3-none-any.whl"
    sha256 "29253a9207ce32b64c3ac6600edc75368f98473906e8fd1043bd6b5b1de2c14a"
  end
  resource "pycparser" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/0c/c3/44f3fbbfa403ea2a7c779186dc20772604442dde72947e7d01069cbe98e3/pycparser-3.0-py3-none-any.whl"
    sha256 "b727414169a36b7d524c1c3e31839a521725078d7b2ff038656844266160a992"
  end
  resource "pydantic" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/fd/7b/122376b1fd3c62c1ed9dc80c931ace4844b3c55407b6fb2d199377c9736f/pydantic-2.13.4-py3-none-any.whl"
    sha256 "45a282cde31d808236fd7ea9d919b128653c8b38b393d1c4ab335c62924d9aba"
  end
  resource "pydantic-settings" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/77/c1/6e422f34e569cf8e18df68d1939c81c099d2b61e4f7d9621c8a77560799c/pydantic_settings-2.14.2-py3-none-any.whl"
    sha256 "a20c97b37910b6550d5ea50fbcc2d4187defe58cd57070b73863d069419c9440"
  end
  resource "pydantic-core" do  # wheel (compiled)
    on_arm do
      on_macos do
        url "https://files.pythonhosted.org/packages/c1/81/4fa520eaffa8bd7d1525e644cd6d39e7d60b1592bc5b516693c7340b50f1/pydantic_core-2.46.4-cp313-cp313-macosx_11_0_arm64.whl"
        sha256 "c94f0688e7b8d0a67abf40e57a7eaaecd17cc9586706a31b76c031f63df052b4"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/03/d5/fd02da45b659668b05923b17ba3a0100a0a3d5541e3bd8fcc4ecb711309e/pydantic_core-2.46.4-cp313-cp313-manylinux_2_17_aarch64.manylinux2014_aarch64.whl"
        sha256 "f027324c56cd5406ca49c124b0db10e56c69064fec039acc571c29020cc87c76"
      end
    end
    on_intel do
      on_macos do
        url "https://files.pythonhosted.org/packages/51/a2/5d30b469c5267a17b39dec53208222f76a8d351dfac4af661888c5aee77d/pydantic_core-2.46.4-cp313-cp313-macosx_10_12_x86_64.whl"
        sha256 "5d5902252db0d3cedf8d4a1bc68f70eeb430f7e4c7104c8c476753519b423008"
      end
      on_linux do
        url "https://files.pythonhosted.org/packages/07/f8/41db9de19d7987d6b04715a02b3b40aea467000275d9d758ffaa31af7d50/pydantic_core-2.46.4-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl"
        sha256 "9551187363ffc0de2a00b2e47c25aeaeb1020b69b668762966df15fc5659dd5a"
      end
    end
  end
  resource "Pygments" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/f4/7e/a72dd26f3b0f4f2bf1dd8923c85f7ceb43172af56d63c7383eb62b332364/pygments-2.20.0-py3-none-any.whl"
    sha256 "81a9e26dd42fd28a23a2d169d86d7ac03b46e2f8b59ed4698fb4785f946d0176"
  end
  resource "python-dotenv" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/0b/d7/1959b9648791274998a9c3526f6d0ec8fd2233e4d4acce81bbae76b44b2a/python_dotenv-1.2.2-py3-none-any.whl"
    sha256 "1d8214789a24de455a8b8bd8ae6fe3c6b69a5e3d64aa8a8e5d68e694bbcb285a"
  end
  resource "requests" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/a0/f4/c67b0b3f1b9245e8d266f0f112c500d50e5b4e83cb6f3b71b6528104182a/requests-2.34.2-py3-none-any.whl"
    sha256 "2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0"
  end
  resource "rich" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/82/3b/64d4899d73f91ba49a8c18a8ff3f0ea8f1c1d75481760df8c68ef5235bf5/rich-15.0.0-py3-none-any.whl"
    sha256 "33bd4ef74232fb73fe9279a257718407f169c09b78a87ad3d296f548e27de0bb"
  end
  resource "sniffio" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/e9/44/75a9c9421471a6c4805dbf2356f7c181a29c1879239abab1ea2cc8f38b40/sniffio-1.3.1-py3-none-any.whl"
    sha256 "2f6da418d1f1e0fddd844478f41680e794e6051915791a034ff65e5f100525a2"
  end
  resource "structlog" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/a9/18/489c97b834dfff9cf2fc2507cede4bcd4b11e67f84bc462acd1992496f86/structlog-26.1.0-py3-none-any.whl"
    sha256 "e081a26d6c373e6d201eca24eede26d8ffab07f88f477822e679183428d3d91e"
  end
  resource "tenacity" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/d7/c1/eb8f9debc45d3b7918a32ab756658a0904732f75e555402972246b0b8e71/tenacity-9.1.4-py3-none-any.whl"
    sha256 "6095a360c919085f28c6527de529e76a06ad89b23659fa881ae0649b867a9d55"
  end
  resource "textual" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/a8/f5/c1e18bc0707300a0e90204343abbf7d7acd6fb7ebe03a6d4893b99a234b8/textual-8.2.7-py3-none-any.whl"
    sha256 "4caaa13a90bc4cf9c6c862c067ccd34fe84e9c161710a2a907a8026313b6bd73"
  end
  resource "typing-inspection" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/dc/9b/47798a6c91d8bdb567fe2698fe81e0c6b7cb7ef4d13da4114b41d239f65d/typing_inspection-0.4.2-py3-none-any.whl"
    sha256 "4ed1cacbdc298c220f1bd249ed5287caa16f34d44ef4e9c3d0cbad5b521545e7"
  end
  resource "typing-extensions" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/18/67/36e9267722cc04a6b9f15c7f3441c2363321a3ea07da7ae0c0707beb2a9c/typing_extensions-4.15.0-py3-none-any.whl"
    sha256 "f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548"
  end
  resource "uc-micro-py" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/61/73/d21edf5b204d1467e06500080a50f79d49ef2b997c79123a536d4a17d97c/uc_micro_py-2.0.0-py3-none-any.whl"
    sha256 "3603a3859af53e5a39bc7677713c78ea6589ff188d70f4fee165db88e22b242c"
  end
  resource "urllib3" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/7f/3e/5db95bcf282c52709639744ca2a8b149baccf648e39c8cc87553df9eae0c/urllib3-2.7.0-py3-none-any.whl"
    sha256 "9fb4c81ebbb1ce9531cce37674bbc6f1360472bc18ca9a553ede278ef7276897"
  end
  resource "websockets" do  # wheel (pure)
    url "https://files.pythonhosted.org/packages/6f/28/258ebab549c2bf3e64d2b0217b973467394a9cea8c42f70418ca2c5d0d2e/websockets-16.0-py3-none-any.whl"
    sha256 "1637db62fad1dc833276dded54215f2c7fa46912301a24bd94d45d46a011ceec"
  end

  def install
    python = "python3.13"
    venv = virtualenv_create(libexec, python)

    # Homebrew's std_pip_args hardcodes `--no-binary=:all:`, which would refuse/recompile our
    # vendored wheels — so install every wheel resource via an explicit pip call WITHOUT that
    # flag. brew caches each download as `<sha256>--<name>`; pip's wheel-name parser rejects that
    # prefix, so copy each wheel back to its clean filename first. Any sdist resource (today just
    # cryptography on macOS-Intel, which publishes no x86_64 wheel) installs normally — building
    # from source there, which is why rust + openssl@3 are scoped to that branch above.
    wheelhouse = buildpath/"wheelhouse"
    wheelhouse.mkpath
    wheels, sdists = resources.partition { |r| r.url.end_with?(".whl") }
    wheel_files = wheels.map do |r|
      dest = wheelhouse/File.basename(r.url)
      cp r.cached_download, dest
      dest
    end
    unless wheel_files.empty?
      system python, "-m", "pip", "--python=#{libexec}/bin/python", "install",
             "--no-deps", "--no-index", "--ignore-installed", "--no-compile", *wheel_files
    end
    venv.pip_install sdists unless sdists.empty?
    venv.pip_install_and_link "#{buildpath}[harness,tui]"
  end

  test do
    assert_match "usage: minima", shell_output("#{bin}/minima --help")
  end
end
