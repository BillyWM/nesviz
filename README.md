# Nesviz

Nesviz is a tool for semi-automatically reverse-engineering NES games

Currently a work in progress

## Current

* Can do some automatic code-discovery on 'mapperless' games and ones that don't swap CHR-ROM (NROM, CNROM, and MMC1 of 32KB or less). Currently using static analysis. Optional CDL files can help discover more code.

* Auto-marking some common code shapes to aid discovery

## Planned

* All major mappers/boards
* Dynamic analysis
	* Talking to the emulator during execution to make discoveries
* Visual map of memory (RAM and ROM) by usage type
* Automatic discovery of level-loading routines, etc
* Connect to an emulator for live analysis (implementation started)
