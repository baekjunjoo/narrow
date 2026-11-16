# 오디오 품질 보고서: 글꼴 및 소프트웨어 고지

## Narravo Report KR Regular 글꼴

보고서의 `NarravoReportKR-Regular.ttf`는 [Google Fonts의 Noto Sans KR 가변 글꼴](https://github.com/google/fonts/blob/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf)을 수정한 것입니다. 원본 글꼴은 Copyright 2014–2021 Adobe, SIL Open Font License 1.1이며, 원문의 예약 글꼴명은 `Source`입니다. 원본 파일의 SHA-256은 `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252`입니다.

변경 내용: FontTools `varLib.instancer`로 굵기 축 `wght=400`을 고정하고, 패밀리·스타일·PostScript 이름을 `Narravo Report KR` 및 `NarravoReportKR-Regular`로 변경했습니다. PDF 문자 추출을 위해 FontTools 4.68.0으로 GSUB·GPOS·GDEF를 제거하고, 같은 글리프를 공유하는 유니코드 코드포인트마다 동일한 외형과 폭의 글리프를 복제하여 일대일 cmap을 만들었습니다. 최종 파일 SHA-256은 `39c41e808acd887a723164d45f924c33f5cd5128d90fa17c826da3aad497269f`입니다. 글꼴은 수정된 전체 글꼴로 PDF에 임베딩합니다. 전체 저작권 및 라이선스는 [QUALITY_REPORT_FONT_OFL.txt](QUALITY_REPORT_FONT_OFL.txt)에 있습니다. OFL 1.1은 조건을 준수할 때 상업적 소프트웨어에 글꼴을 포함·임베딩하는 것을 허용하나, 글꼴 자체만 따로 판매할 수 없습니다.

## 보고서 생성 소프트웨어

- [pdf-lib 1.17.1](https://github.com/Hopding/pdf-lib): MIT, Copyright 2019 Andrew Dillon. [라이선스 원문](QUALITY_REPORT_PDF_LIB_MIT.txt).
- [@pdf-lib/fontkit 1.1.1](https://github.com/Hopding/fontkit): MIT, Copyright 2014–present Devon Govett. 원본 fontkit의 포크입니다. [라이선스 원문](QUALITY_REPORT_FONTKIT_MIT.txt).
- @pdf-lib/standard-fonts 1.0.0: MIT. [라이선스 원문](QUALITY_REPORT_STANDARD_FONTS_MIT.txt).
- @pdf-lib/upng 1.0.1: MIT. [라이선스 원문](QUALITY_REPORT_UPNG_MIT.txt).
- pako 1.0.11: MIT 및 zlib. [라이선스 원문](QUALITY_REPORT_PAKO_LICENSE.txt).
- tslib 1.14.1: 0BSD. [라이선스 원문](QUALITY_REPORT_TSLIB_LICENSE.txt).

라이선스 조건은 각 원문을 기준으로 합니다. 위 라이브러리는 기기에서 보고서를 생성하며, 원고·음원·검사 결과를 서버로 전송하는 데 사용하지 않습니다.
