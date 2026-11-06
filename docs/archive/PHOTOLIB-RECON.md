# Photolib recon — Photos Library.photoslibrary

- Library: `/Volumes/bryan/FTP Server Backup/Drive 1 Backup/Photos Library.photoslibrary` (photos)
- Generated: 2026-11-06T23:46:18.496Z

## DB
| metric | value |
|---|---|
| masters | 3189 |
| inTrash | 0 |
| missingFlag | 0 |
| referenced | 0 |
| videos | 174 |
| photos | 3015 |
| bytes | 24.37 GB |
| versions | 3189 |
| versionsWithAdjustments | 9 |
| adjustmentRows | 140 |
| favorites | 0 |
| hidden | 0 |
| titled | 0 |
| described | 0 |
| keywordLinks | 0 |
| gps | 2648 |
| tzName | 3189 |
| tzOffset | 3189 |
| dated | 3189 |
| liveGroups | 70 |
| liveMembers | 73 |
| userAlbums | 0 |
| albumLinks | 1113 |
| byUti | public.jpeg 2771 · public.png 242 · com.apple.quicktime-movie 154 · public.mpeg-4 20 · com.compuserve.gif 2 |
| date range (UTC) | 2014-03-07 16:10:07 → 2019-01-24 19:31:27 |
| by year | 2014 1 · 2015 1 · 2018 2601 · 2019 586 |
| tz names | GMT-0559 6 · GMT-0500 1493 · GMT-0600 675 · GMT-0700 13 · America/Chicago 175 · GMT-0400 110 · GMT-1000 625 · GMT-0937 1 · GMT-0459 28 · GMT-0516 1 · GMT-0449 1 · GMT-0406 3 · GMT-0800 55 · GMT-0921 2 · GMT-0900 1 |

## Disk vs DB
| metric | value |
|---|---|
| Masters files on disk | 3426 (.jpg 2977 · .png 266 · .mov 157 · .jpeg 4 · .mp4 20 · .gif 2) |
| DB masters missing on disk | 0 |
| orphan files (on disk, not in DB) | 237 · 7.71 GB · .jpg 210 · .png 24 · .mov 3 |
| orphans with own capture date | 190 / 237 (ContentIdentifier 0) |
| resources files | 7303 · mov 67 · fullsizeoutput 251 |
| resources dirs | .metadata_never_index 1 · media/face 386 · media/master 309 · media/version 9 · moments/analysismetadata.plist 1 · moments/historicalmarker.plist 1 · moments/needsanalysis 1 · moments/serverinfo.plist 1 · proxies/derivatives 6554 · recovery/Info.plist 1 · recovery/RKAdjustmentData 1 · recovery/RKAdminData 1 · recovery/RKAlbum 1 · recovery/RKAlbumVersion 1 · recovery/RKAttachment 1 · recovery/RKCustomSortOrder 1 · recovery/RKFace 1 · recovery/RKFaceGroup 1 · recovery/RKFacePrint 1 · recovery/RKFolder 1 · recovery/RKImageProxyState 2 · recovery/RKImportGroup 1 · recovery/RKKeyword 1 · recovery/RKMaster 4 · recovery/RKMemory 1 · recovery/RKMemoryCuratedVersion 1 · recovery/RKMemoryRepresentativeVersion 1 · recovery/RKModelResource 1 · recovery/RKPerson 1 · recovery/RKPlace 1 · recovery/RKPlaceForVersion 1 · recovery/RKSceneInVersion 1 · recovery/RKVersion 8 · recovery/RKVersionAnalysisState 1 · segments/Thumb64Segment_0.data 1 · segments/Thumb64Segment_1.data 1 · segments/ThumbJPGSegment_0.data 1 · segments/ThumbJPGSegment_1.data 1 |
| live pairs | DB groups 70 · MOVs w/ ContentIdentifier 67 · matched 67 |
| dupes within library (fingerprint) | 4 |
| est. copy | 3422 files · 32.07 GB (unique DB masters + orphan files; exact sha dedupe happens in P1) |

Orphan sample:
- `2018/10/24/20181024-201030/IMG_0104.JPG`
- `2018/10/24/20181024-201030/IMG_0105.JPG`
- `2018/10/24/20181024-201030/IMG_0106.JPG`
- `2018/10/24/20181024-201030/IMG_0107.JPG`
- `2018/10/24/20181024-201030/IMG_0108.JPG`
- `2018/10/24/20181024-201030/IMG_0109.JPG`
- `2018/10/24/20181024-201030/IMG_0110.JPG`
- `2018/10/24/20181024-201030/IMG_0111.JPG`
- `2018/10/24/20181024-201030/IMG_0114.JPG`
- `2018/10/24/20181024-201030/IMG_0115.JPG`
- `2018/10/24/20181024-201030/IMG_0116.JPG`
- `2018/10/24/20181024-201030/IMG_0117.JPG`
- `2018/10/24/20181024-201030/IMG_0118.JPG`
- `2018/10/24/20181024-201030/IMG_0119.JPG`
- `2018/10/24/20181024-201030/IMG_0120.JPG`

Resources samples:
- `media/master/00/00/jpegvideocomplement_25.mov`
- `media/master/00/00/jpegvideocomplement_a5.mov`
- `media/master/00/00/jpegvideocomplement_a6.mov`
- `media/master/00/00/jpegvideocomplement_a7.mov`
- `media/master/00/00/jpegvideocomplement_a8.mov`
- `media/master/00/00/fullsizeoutput_1.jpeg`
- `media/master/00/00/fullsizeoutput_10.jpeg`
- `media/master/00/00/fullsizeoutput_11.jpeg`
- `media/master/00/00/fullsizeoutput_12.jpeg`
- `media/master/00/00/fullsizeoutput_13.jpeg`

## EXIF spot-check (DB imageDate vs EXIF DateTimeOriginal)
Sampled 25, EXIF-dated 22. Match if imageDate = UTC instant (+tz): **22** · if wall clock: **0**.

| file | EXIF | EXIF offset | DB utc+tz | DB raw | tz |
|---|---|---|---|---|---|
| 2019/01/24/20190124-220855/IMG_1914.JPG | 2018-12-09 08:45:22 | — | 2018-12-09 08:45:22 | 2018-12-09 16:45:22 | GMT-0800 |
| 2018/10/24/20181024-201030/IMG_8333.JPG | 2018-05-15 20:42:50 | — | 2018-05-15 20:42:50 | 2018-05-16 01:42:50 | GMT-0500 |
| 2018/10/31/20181031-165620/IMG_0917.PNG | — | — | 2018-09-28 20:41:19 | 2018-09-29 01:41:19 | GMT-0500 |
| 2019/01/24/20190124-220855/IMG_2481.JPG | 2019-01-09 13:36:19 | — | 2019-01-09 13:36:19 | 2019-01-09 23:36:19 | GMT-1000 |
| 2018/10/24/20181024-201030/IMG_8979.JPG | 2018-06-20 00:53:37 | — | 2018-06-20 00:53:37 | 2018-06-20 05:53:37 | GMT-0500 |
| 2019/01/24/20190124-220855/IMG_2406.JPG | 2019-01-08 14:47:29 | — | 2019-01-08 14:47:29 | 2019-01-09 00:47:29 | GMT-1000 |
| 2018/10/31/20181031-165620/IMG_1223.PNG | — | — | 2018-10-17 18:16:27 | 2018-10-17 23:16:27 | GMT-0500 |
| 2018/10/31/20181031-165620/IMG_1355.JPG | 2018-10-26 12:01:20 | — | 2018-10-26 12:01:20 | 2018-10-26 17:01:20 | GMT-0500 |
| 2018/10/31/20181031-165620/IMG_0252.PNG | — | — | 2018-08-08 12:33:48 | 2018-08-08 17:33:48 | GMT-0500 |
| 2018/10/24/20181024-201030/IMG_9982.JPG | 2018-07-28 12:39:10 | — | 2018-07-28 12:39:10 | 2018-07-28 17:39:10 | GMT-0500 |
| 2019/01/22/20190122-160634/IMG_1937.JPG | 2018-02-17 12:35:36 | — | 2018-02-17 12:35:36 | 2018-02-17 18:35:36 | GMT-0600 |
| 2019/01/24/20190124-220855/IMG_1742.JPG | 2018-11-22 14:45:13 | — | 2018-11-22 14:45:13 | 2018-11-22 20:45:13 | GMT-0600 |
| 2018/10/31/20181031-165620/IMG_0832.JPG | 2018-09-23 12:43:58 | — | 2018-09-23 12:43:58 | 2018-09-23 17:43:58 | GMT-0500 |
| 2019/01/24/20190124-220855/IMG_E2667.JPG | 2019-01-24 13:31:27 | — | 2019-01-24 13:31:27 | 2019-01-24 19:31:27 | GMT-0600 |
| 2018/10/31/20181031-165620/IMG_0120.JPG | 2018-08-03 18:41:00 | — | 2018-08-03 18:41:00 | 2018-08-03 23:41:00 | GMT-0500 |
| 2018/10/31/20181031-165620/IMG_0824.JPG | 2018-09-22 13:47:33 | — | 2018-09-22 13:47:33 | 2018-09-22 18:47:33 | GMT-0500 |
| 2019/01/24/20190124-220855/IMG_2859.JPG | 2019-01-10 13:10:16 | — | 2019-01-10 13:10:16 | 2019-01-10 23:10:16 | GMT-1000 |
| 2018/10/31/20181031-165620/IMG_1122.JPG | 2018-10-09 18:15:15 | — | 2018-10-09 18:15:15 | 2018-10-09 23:15:15 | GMT-0500 |
| 2019/01/24/20190124-220855/56602135246__308B1E6F-D249-4E99-B852-3B801A6049CD.JPG | 2018-12-08 20:09:12 | — | 2018-12-08 20:09:12 | 2018-12-09 02:09:12 | GMT-0600 |
| 2018/10/31/20181031-165620/IMG_0295.JPG | 2018-08-11 13:44:53 | — | 2018-08-11 13:44:53 | 2018-08-11 17:44:53 | GMT-0400 |
| 2018/10/31/20181031-165620/IMG_0730.JPG | 2018-09-13 19:45:47 | — | 2018-09-13 19:45:47 | 2018-09-14 00:45:47 | GMT-0500 |
| 2019/01/24/20190124-220855/IMG_1921.JPG | 2018-12-09 22:35:37 | — | 2018-12-09 22:35:37 | 2018-12-10 04:35:37 | GMT-0600 |
| 2019/01/24/20190124-220855/IMG_E2057.JPG | 2018-12-23 17:44:19 | — | 2018-12-23 17:44:19 | 2018-12-23 23:44:19 | GMT-0600 |
| 2019/01/24/20190124-220855/IMG_E2532.JPG | 2019-01-10 17:07:40 | — | 2019-01-10 17:07:40 | 2019-01-11 03:07:40 | GMT-1000 |
| 2018/10/31/20181031-165620/IMG_0882.JPG | 2018-09-26 22:36:09 | — | 2018-09-26 22:36:09 | 2018-09-27 03:36:09 | GMT-0500 |

## Cross-library overlap (name+size)
- `/Volumes/bryan/FTP Server Backup/SeagateBackup_to_ue_830_H/Pictures/iPhoto Library` (iphoto): 3492 masters, 0 overlap
