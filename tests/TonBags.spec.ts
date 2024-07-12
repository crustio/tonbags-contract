import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, Dictionary, beginCell, toNano, fromNano } from '@ton/core';
import { TonBags } from '../wrappers/TonBags';
import { StorageContract } from '../wrappers/StorageContract';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    error_unauthorized, error_not_enough_storage_fee, error_duplicated_torrent_hash,
    error_file_too_small, error_file_too_large, error_storage_order_unexpired, error_unregistered_storage_provider,
    op_recycle_undistributed_storage_fees, op_unregister_as_storage_provider, op_submit_storage_proof,
    op_register_as_storage_provider, op_claim_storage_rewards
} from '../wrappers/constants';
import { getMerkleRoot } from "./merkleProofUtils";
import { ONE_HOUR_IN_SECS, expectBigNumberEquals, default_storage_period } from "./utils";

describe('TonBags', () => {
    let tonBagsCode: Cell;
    let storageContractCode: Cell;

    let blockchain: Blockchain;
    let Alice: SandboxContract<TreasuryContract>;
    let Bob: SandboxContract<TreasuryContract>;
    let Caro: SandboxContract<TreasuryContract>;
    let Dave: SandboxContract<TreasuryContract>;
    let Eva: SandboxContract<TreasuryContract>;
    let tonBags: SandboxContract<TonBags>;

    let emptyBagStorageContractDict: Dictionary<number, Address>;

    beforeAll(async () => {
        tonBagsCode = await compile('TonBags');
        storageContractCode = await compile('StorageContract');

        blockchain = await Blockchain.create();
        Alice = await blockchain.treasury('Alice');
        Bob = await blockchain.treasury('Bob');
        Caro = await blockchain.treasury('Caro');
        Dave = await blockchain.treasury('Dave');
        Eva = await blockchain.treasury('Eva');
        emptyBagStorageContractDict = Dictionary.empty();

        tonBags = blockchain.openContract(
            TonBags.createFromConfig(
                {
                    adminAddress: Alice.address,
                    storageContractCode,
                    bagStorageContractDict: emptyBagStorageContractDict,
                },
                tonBagsCode
            )
        );
        
        const deployResult = await tonBags.sendDeploy(Alice.getSender(), toNano('0.1'));
        expect(deployResult.transactions).toHaveTransaction({
            from: Alice.address,
            to: tonBags.address,
            deploy: true,
            success: true
        });

        // https://github.com/ton-org/sandbox?tab=readme-ov-file#viewing-logs
        await blockchain.setVerbosityForAddress(tonBags.address, {
            print: true,
            blockchainLogs: false,
            vmLogs: 'none',  // 'none' | 'vm_logs' | 'vm_logs_full'
            debugLogs: true
        })
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
        // blockchain and tonBags are ready to use
    });

    it('minter admin can change admin', async () => {
        expect(await tonBags.getAdminAddress()).toEqualAddress(Alice.address);

        let changeAdmin = await tonBags.sendUpdateAdmin(Alice.getSender(), Bob.address);
        expect(await tonBags.getAdminAddress()).toEqualAddress(Bob.address);

        changeAdmin = await tonBags.sendUpdateAdmin(Bob.getSender(), Alice.address);
        expect(await tonBags.getAdminAddress()).toEqualAddress(Alice.address);
    });

    it('not a minter admin can not change admin', async () => {
        let changeAdmin = await tonBags.sendUpdateAdmin(Bob.getSender(), Bob.address);
        expect(await tonBags.getAdminAddress()).toEqualAddress(Alice.address);
        expect(changeAdmin.transactions).toHaveTransaction({
            from: Bob.address,
            to: tonBags.address,
            aborted: true,
            exitCode: error_unauthorized
        });
    });

    it('anyone could place order to create a storage contract', async () => {
        const dataArray = [
            0x0BAD0010n,
            0x60A70020n,
            0xBEEF0030n,
            0xDEAD0040n,
            0xCA110050n,
            0x0E660060n,
            0xFACE0070n,
            0xBAD00080n,
            0x060D0091n
        ];
        const merkleRoot = getMerkleRoot(dataArray);
        const torrentHash = BigInt('0x476848C3350EA64ACCC09218917132998267F2ABC283097082FD41D511CAF11B');
        const fileSize = 1024n * 1024n * 10n;  // 10MB

        expect(await tonBags.getStorageContractAddress(torrentHash)).toBeNull();

        let trans = await tonBags.sendPlaceStorageOrder(Bob.getSender(), torrentHash, fileSize, merkleRoot, toNano('1'));
        expect(trans.transactions).toHaveTransaction({
            from: Bob.address,
            to: tonBags.address,
            success: true
        });

        expect(await tonBags.getStorageContractAddress(torrentHash)).not.toBeNull();

        trans = await tonBags.sendPlaceStorageOrder(Caro.getSender(), torrentHash, fileSize, merkleRoot, toNano('1'));
        expect(trans.transactions).toHaveTransaction({
            from: Caro.address,
            to: tonBags.address,
            aborted: true,
            exitCode: error_duplicated_torrent_hash,
            success: false
        });

        const torrentHash2 = BigInt('0x476848C3350EA64ACCC09218917132998267F2ABC283097082FD41D511CAF11C');
        trans = await tonBags.sendPlaceStorageOrder(Caro.getSender(), torrentHash2, fileSize, merkleRoot, toNano('1'));
        expect(trans.transactions).toHaveTransaction({
            from: Caro.address,
            to: tonBags.address,
            success: true
        });
        expect(await tonBags.getStorageContractAddress(torrentHash2)).not.toBeNull();
        expect(await tonBags.getStorageContractAddress(torrentHash)).not.toEqual(await tonBags.getStorageContractAddress(torrentHash2));

        const torrentHash3 = BigInt('0x476848C3350EA64ACCC09218917132998267F2ABC283097082FD41D511CAF11D');
        trans = await tonBags.sendPlaceStorageOrder(Caro.getSender(), torrentHash3, 0n, merkleRoot, toNano('1'));
        expect(trans.transactions).toHaveTransaction({
            from: Caro.address,
            to: tonBags.address,
            aborted: true,
            exitCode: error_file_too_small,
            success: false
        });

        trans = await tonBags.sendPlaceStorageOrder(Caro.getSender(), torrentHash3, 1024n * 1024n * 1024n * 100n, merkleRoot, toNano('1'));
        expect(trans.transactions).toHaveTransaction({
            from: Caro.address,
            to: tonBags.address,
            aborted: true,
            exitCode: error_file_too_large,
            success: false
        });

        trans = await tonBags.sendPlaceStorageOrder(Caro.getSender(), torrentHash3, 1024n * 1024n * 100n, merkleRoot, toNano('0.01'));
        expect(trans.transactions).toHaveTransaction({
            from: Caro.address,
            to: tonBags.address,
            aborted: true,
            exitCode: error_not_enough_storage_fee,
            success: false
        });

    });

    it('storage contract works', async () => {
        console.log(fromNano(await tonBags.getBalance()));
        const tonBagsBalanceBeforeDeployStorageContract = await tonBags.getBalance();

        const dataArray = [ 0x0BAD0010n, 0x60A70020n, 0xBEEF0030n, 0xDEAD0040n, 0xCA110050n, 0x0E660060n, 0xFACE0070n, 0xBAD00080n, 0x060D0091n ];
        const merkleRoot = getMerkleRoot(dataArray);
        const someInvalidMerkleRoot = merkleRoot - 1n;
        const torrentHash = BigInt('0x676848C3350EA64ACCC09218917132998267F2ABC283097082FD41D511CAF11B');
        const fileSize = 1024n * 1024n * 10n;  // 10MB
        // Distribute 43.2 $TON over 180 days. Workers must submit their report at most every 1 hour
        // 1 day rewards: 43.2 / 180 = 0.24 $TON
        // 1 hour rewards: 0.24 / 24 = 0.01
        const totalStorageFee = toNano('43.2');

        expect(await tonBags.getStorageContractAddress(torrentHash)).toBeNull();
        let trans = await tonBags.sendPlaceStorageOrder(Dave.getSender(), torrentHash, fileSize, merkleRoot, totalStorageFee);
        expect(trans.transactions).toHaveTransaction({
            from: Dave.address,
            to: tonBags.address,
            success: true
        });
        expect(await tonBags.getStorageContractAddress(torrentHash)).not.toBeNull();

        const storageContract = blockchain.openContract(
            StorageContract.createFromAddress(
                await tonBags.getStorageContractAddress(torrentHash) || Alice.address
            )
        );

        let [contractTorrentHash, ownerAddress, fileMerkleHash, fileSizeInBytes] = await storageContract.getBagInfo();
        expect(contractTorrentHash).toEqual(torrentHash);
        expect(ownerAddress).toEqualAddress(Dave.address);
        expect(fileMerkleHash).toEqual(merkleRoot);
        expect(fileSizeInBytes).toEqual(fileSize);
        expect(await storageContract.getEarned(Alice.address)).toEqual(0n);

        console.log(fromNano(await tonBags.getBalance()));
        console.log(fromNano(await storageContract.getBalance()));

        // TonBags balance should remain unchanged
        // expect(await tonBags.getBalance()).toEqual(tonBagsBalanceBeforeDeployStorageContract);
        expectBigNumberEquals(tonBagsBalanceBeforeDeployStorageContract, await tonBags.getBalance());

        // Storage fees and remaining gas should go to new storage contract
        expect(await storageContract.getBalance()).toBeGreaterThan(totalStorageFee);

        // Not started until first registered storage provider
        expect(await storageContract.getStarted()).toBeFalsy();
        expect(await storageContract.getPeriodFinish()).toEqual(0n);

        // Can't recycle pool before start or finish
        trans = await storageContract.sendRecycleUndistributedStorageFees(Dave.getSender(), Bob.address);
        expect(trans.transactions).toHaveTransaction({
            from: Dave.address,
            to: storageContract.address,
            aborted: true,
            exitCode: error_storage_order_unexpired,
            success: false
        });

        // Storage providers can't exit or submit work report before register
        trans = await storageContract.sendUnregisterAsStorageProvider(Alice.getSender());
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            aborted: true,
            exitCode: error_unregistered_storage_provider,
            success: false
        });
        expect(await storageContract.getNextProof(Alice.address)).toEqual(-1n);
        trans = await storageContract.sendSubmitStorageProof(Alice.getSender(), merkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            aborted: true,
            exitCode: error_unregistered_storage_provider,
            success: false
        });

        // Day 0: Alice registers as a worker
        // Alice Timeline: 
        //       Genesis Time (Joined)
        const genesisTime = Math.floor(Date.now() / 1000);
        blockchain.now = genesisTime;
        console.log(`Hour 0: Alice registers as a storage provider`);
        trans = await storageContract.sendRegisterAsStorageProvider(Alice.getSender());
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_register_as_storage_provider,
            success: true
        });
        expect(await storageContract.getStarted()).toEqual(true);
        expectBigNumberEquals(await storageContract.getPeriodFinish(), BigInt(genesisTime) + default_storage_period);
        expect(await storageContract.getTotalStorageProviders()).toEqual(1n);

        // Total rewards: 0.1 $TON per day
        // Alice Timeline: 
        //       Genesis Time (Joined)
        //       + 1 hour (Submit valid report => 1 hour rewards => claimed) 
        let totalRewardsPerHour = totalStorageFee / 180n / 24n;
        console.log("totalRewardsPerHour: ", totalRewardsPerHour);
        console.log(`Hour 1: Alice submits a valid report`);
        blockchain.now += ONE_HOUR_IN_SECS - 1;
        trans = await storageContract.sendSubmitStorageProof(Alice.getSender(), merkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_submit_storage_proof,
            success: true
        });
        // console.log(await storageContract.getEarned(Alice.address), totalRewardsPerHour);
        console.log(`Hour 1: Alice claims rewards`);
        expectBigNumberEquals(await storageContract.getEarned(Alice.address), totalRewardsPerHour);
        trans = await storageContract.sendClaimStorageRewards(Alice.getSender());
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_claim_storage_rewards,
            success: true
        });

        // After 1.5 hour, Alice submit another valid report. And earns nothing
        // Alice Timeline: 
        //       Genesis Time (Joined)
        //       + 1 hour (Submit valid report => 1 hour rewards) 
        //       + 1.5 hour (Submit valid report => ignored due to timeout => 1.5 hours rewards undistributed )
        console.log(`Hour 2.5: Alice submits a valid report. Should be ignored due to timeout`);
        blockchain.now += ONE_HOUR_IN_SECS * 3 / 2;
        trans = await storageContract.sendSubmitStorageProof(Alice.getSender(), merkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_submit_storage_proof,
            success: true
        });
        expect(await storageContract.getEarned(Alice.address)).toEqual(0n);
        // console.log(await storageContract.getUndistributedRewards(), totalRewardsPerHour * 3n / 2n);
        expectBigNumberEquals(await storageContract.getUndistributedRewards(), totalRewardsPerHour * 3n / 2n);

        // After 0.5 hour, Alice submit another valid report, should earn 0.5 hour rewards
        // Alice Timeline: 
        //       Genesis Time (Joined)
        //       + 1 hour (Submit valid report => 1 hour rewards) 
        //       + 1.5 hour (Submit valid report => ignored due to timeout => 1.5 hours rewards undistributed )
        //       + 0.5 hour (Submit valid report => 0.5 hours rewards)
        console.log(`Hour 3.0: Alice submits a valid report, should earn 0.5 hour rewards`);
        blockchain.now += ONE_HOUR_IN_SECS / 2 - 1;
        let lastTime = blockchain.now;
        trans = await storageContract.sendSubmitStorageProof(Alice.getSender(), merkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_submit_storage_proof,
            success: true
        });
        expect(await storageContract.getLastProofValid(Alice.address)).not.toBeFalsy();
        expectBigNumberEquals(await storageContract.getEarned(Alice.address), totalRewardsPerHour / 2n);

        // Bob register as a storage provider
        // Bob Timeline: 
        //       Genesis Time
        //       + 1 hour
        //       + 1.5 hour
        //       + 0.5 hour (Joined)
        console.log(`Hour 3.0: Bob registers as a storage provider`);
        trans = await storageContract.sendRegisterAsStorageProvider(Bob.getSender());
        expect(trans.transactions).toHaveTransaction({
            from: Bob.address,
            to: storageContract.address,
            op: op_register_as_storage_provider,
            success: true
        });
        expect(await storageContract.getTotalStorageProviders()).toEqual(2n);

        // 0.5 hour later, Alice submit an invlid report, which should be ignored
        // Alice Timeline: 
        //       Genesis Time (Joined)
        //       + 1 hour (Submit valid report => 1 hour rewards) 
        //       + 1.5 hour (Submit valid report => ignored due to timeout => 1.5 hours rewards undistributed )
        //       + 0.5 hour (Submit valid report => 0.5 hours rewards)
        //       + 0.5 hour (Submit invalid report => ignored)
        console.log(`Hour 3.5: Alice submits a valid report`);
        blockchain.now += ONE_HOUR_IN_SECS / 2;
        trans = await storageContract.sendSubmitStorageProof(Alice.getSender(), someInvalidMerkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_submit_storage_proof,
            success: true
        });
        expect(await storageContract.getLastProofValid(Alice.address)).toBeFalsy();

        // 0.5 hour later, both Alice and Bob submit valid reports
        // Alice Timeline: 
        //       Genesis Time (Joined)
        //       + 1 hour (Submit valid report => 1 hour rewards) 
        //       + 1.5 hour (Submit valid report => ignored due to timeout => 1.5 hours rewards undistributed )
        //       + 0.5 hour (Submit valid report => 0.5 hours rewards)
        //       + 0.5 hour (Submit invalid report => ignored)
        //       + 0.5 hour (Submit valid report => another 1 hours rewards / 2)
        // Bob Timeline: 
        //       Genesis Time
        //       + 1 hour
        //       + 1.5 hour
        //       + 0.5 hour (Joined)
        //       + 0.5 hour
        //       + 0.5 hour (Submit valid report => 1 hours rewards / 2)
        blockchain.now = lastTime + ONE_HOUR_IN_SECS - 1;
        lastTime = blockchain.now;
        trans = await storageContract.sendSubmitStorageProof(Alice.getSender(), merkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Alice.address,
            to: storageContract.address,
            op: op_submit_storage_proof,
            success: true
        });
        expect(await storageContract.getLastProofValid(Alice.address)).not.toBeFalsy();
        trans = await storageContract.sendSubmitStorageProof(Bob.getSender(), merkleRoot);
        expect(trans.transactions).toHaveTransaction({
            from: Bob.address,
            to: storageContract.address,
            op: op_submit_storage_proof,
            success: true
        });
        expect(await storageContract.getLastProofValid(Bob.address)).not.toBeFalsy();
        expectBigNumberEquals(await storageContract.getEarned(Alice.address), totalRewardsPerHour / 2n + totalRewardsPerHour / 2n);
        expectBigNumberEquals(await storageContract.getEarned(Bob.address), totalRewardsPerHour / 2n);

        



    });


});
